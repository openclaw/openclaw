// Handles device/node-originated events and routes them to sessions/channels.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";
import {
  validateNodeHostStatsPayload,
  validateNodePresenceActivityPayload,
} from "../../packages/gateway-protocol/src/index.js";
import { DesktopAvailabilitySchema } from "../../packages/gateway-protocol/src/schema/environments.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { getRuntimeConfig } from "../config/io.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { updatePairedDevicePresence } from "../infra/device-pairing.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../infra/event-session-routing.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import type { PromptImageOrderEntry } from "../media/prompt-image-order.js";
import { deleteMediaBuffer } from "../media/store.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { normalizeMainKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAgentHarnessSessionContextError } from "../sessions/agent-harness-session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NODE_HOST_STATS_EVENT } from "../shared/node-host-stats.js";
import {
  NODE_PRESENCE_ALIVE_EVENT,
  NODE_PRESENCE_ACTIVITY_EVENT,
  normalizeNodePresenceAliveReason,
} from "../shared/node-presence.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import { resolveChatAttachmentMaxBytes } from "./chat-attachment-policy.js";
import {
  INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
} from "./chat-attachments.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./server-methods/attachment-normalize.js";
import {
  captureNodeEventConfig,
  compactNodeEventText,
  withNodeEventSessionSource,
  isNodeEventConnectionCurrent,
  pairingChangedResult,
  parseNodeEventPayload,
  type NodeEventSessionSource,
} from "./server-node-event-source.js";
import { registerNodeApnsEvent } from "./server-node-events-apns.js";
import { enqueueNodeExecNotice } from "./server-node-events-exec-notice.js";
import { handleNodeNotificationEvent } from "./server-node-events-notifications.js";
import type {
  NodeEvent,
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { resolveGatewayModelSupportsImages, resolveSessionModelRef } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

const MAX_EXEC_EVENT_OUTPUT_CHARS = 180;
const VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS = 1500;
const MAX_RECENT_VOICE_TRANSCRIPTS = 200;
const EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECENT_EXEC_FINISHED_RUNS = 2000;
const NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS = 60_000;
const MAX_RECENT_NODE_PRESENCE_KEYS = 1024;

const recentVoiceTranscripts = new Map<string, { fingerprint: string; ts: number }>();
type VoiceTranscriptReservationAdmission = { work: Promise<unknown> } | null;
type VoiceTranscriptReservation = {
  fingerprint: string;
  receivedAt: number;
  status: "pending" | "ready" | "checking" | "rejected";
  isConnectionCurrent?: () => boolean | Promise<boolean>;
  assertCurrent?: () => void;
  start?: () => Promise<unknown>;
  resolve: (admission: VoiceTranscriptReservationAdmission) => void;
  rejectDecision: (reason: unknown) => void;
};
const pendingVoiceTranscriptReservations = new Map<string, VoiceTranscriptReservation[]>();
const recentExecFinishedRuns = new Map<string, number>();
const recentNodePresencePersistAt = new Map<string, number>();

type NodeAgentCommandInput = Parameters<typeof agentCommandFromIngress>[0];

function normalizeFiniteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function resolveVoiceTranscriptFingerprint(obj: Record<string, unknown>, text: string): string {
  const eventId =
    normalizeOptionalString(obj.eventId) ??
    normalizeOptionalString(obj.providerEventId) ??
    normalizeOptionalString(obj.transcriptId);
  if (eventId) {
    return `event:${eventId}`;
  }

  const callId = normalizeOptionalString(obj.providerCallId) ?? normalizeOptionalString(obj.callId);
  const sequence = normalizeFiniteInteger(obj.sequence) ?? normalizeFiniteInteger(obj.seq);
  if (callId && sequence !== null) {
    return `call-seq:${callId}:${sequence}`;
  }

  const eventTimestamp =
    normalizeFiniteInteger(obj.timestamp) ??
    normalizeFiniteInteger(obj.ts) ??
    normalizeFiniteInteger(obj.eventTimestamp);
  if (callId && eventTimestamp !== null) {
    return `call-ts:${callId}:${eventTimestamp}`;
  }

  if (eventTimestamp !== null) {
    return `timestamp:${eventTimestamp}|text:${text}`;
  }

  return `text:${text}`;
}

function shouldDropDuplicateVoiceTranscript(params: {
  sessionKey: string;
  fingerprint: string;
  now: number;
}): boolean {
  // Voice providers can replay identical transcript fragments during reconnect.
  // Keep only a bounded last fingerprint per session to avoid duplicate sends.
  const previous = recentVoiceTranscripts.get(params.sessionKey);
  if (
    previous &&
    previous.fingerprint === params.fingerprint &&
    params.now - previous.ts <= VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }
  recentVoiceTranscripts.set(params.sessionKey, {
    fingerprint: params.fingerprint,
    ts: params.now,
  });

  if (recentVoiceTranscripts.size > MAX_RECENT_VOICE_TRANSCRIPTS) {
    const cutoff = params.now - VOICE_TRANSCRIPT_DEDUPE_WINDOW_MS * 2;
    for (const [key, value] of recentVoiceTranscripts) {
      if (value.ts < cutoff) {
        recentVoiceTranscripts.delete(key);
      }
      if (recentVoiceTranscripts.size <= MAX_RECENT_VOICE_TRANSCRIPTS) {
        break;
      }
    }
    pruneMapToMaxSize(recentVoiceTranscripts, MAX_RECENT_VOICE_TRANSCRIPTS);
  }

  return false;
}

function shouldDropDuplicateExecFinished(params: {
  sessionKey: string;
  runId: string;
  now: number;
}): boolean {
  const fingerprint = `${params.sessionKey}::${params.runId}`;
  const previousTs = recentExecFinishedRuns.get(fingerprint);
  if (
    typeof previousTs === "number" &&
    params.now - previousTs <= EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS
  ) {
    return true;
  }

  recentExecFinishedRuns.set(fingerprint, params.now);
  pruneBoundedTimestampMap(recentExecFinishedRuns, {
    now: params.now,
    ttlMs: EXEC_FINISHED_RUN_DEDUPE_WINDOW_MS,
    maxEntries: MAX_RECENT_EXEC_FINISHED_RUNS,
  });

  return false;
}

function pruneBoundedTimestampMap(
  map: Map<string, number>,
  params: { now: number; ttlMs: number; maxEntries: number },
) {
  if (map.size <= params.maxEntries) {
    return;
  }
  const cutoff = params.now - params.ttlMs;
  for (const [key, ts] of map) {
    if (ts < cutoff) {
      map.delete(key);
    }
    if (map.size <= params.maxEntries) {
      return;
    }
  }
  pruneMapToMaxSize(map, params.maxEntries);
}

type LoadedSessionEntry = Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;

async function touchSessionStore(params: {
  storePath: LoadedSessionEntry["storePath"];
  canonicalKey: LoadedSessionEntry["canonicalKey"];
  sessionId: string;
  now: number;
  assertCurrent?: () => void;
}) {
  const { storePath } = params;
  if (!storePath) {
    return;
  }
  await upsertSessionEntryCore(
    {
      sessionKey: params.canonicalKey,
      storePath,
    },
    {
      sessionId: params.sessionId,
      updatedAt: params.now,
    },
    { workerGuard: { assertCurrent: params.assertCurrent } },
  );
}

function queueSessionStoreTouch(
  params: Parameters<typeof touchSessionStore>[0] & {
    ctx: NodeEventContext;
    isConnectionCurrent?: () => boolean | Promise<boolean>;
  },
): Promise<void> {
  // Voice dispatch intentionally does not wait for persistence, but a host
  // snapshot must not race the accepted write after its node RPC returns.
  return runWithGatewayIndependentRootWorkContinuation(async () => {
    if (params.isConnectionCurrent && !(await params.isConnectionCurrent())) {
      return;
    }
    await touchSessionStore(params);
  }, "node-events:voice-persist").catch((err: unknown) => {
    params.ctx.logGateway.warn("voice session-store update failed: " + formatForLog(err));
  });
}

async function cleanupNodeEventMedia(
  media: Iterable<{ id: string }>,
  ctx: Pick<NodeEventContext, "logGateway">,
): Promise<void> {
  for (const { id } of media) {
    try {
      await deleteMediaBuffer(id);
    } catch (cleanupErr) {
      ctx.logGateway.warn(
        `Failed to cleanup orphaned media ${id}: ${formatErrorMessage(cleanupErr)}`,
      );
    }
  }
}

export const handleNodeEvent = (
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
): Promise<NodeEventHandleResult | undefined> =>
  withNodeEventSessionSource(evt, opts, (preparedOptions, source) =>
    handlePreparedNodeEvent(ctx, nodeId, evt, preparedOptions, source),
  );

async function handlePreparedNodeEvent(
  ctx: NodeEventContext,
  nodeId: string,
  evt: NodeEvent,
  opts?: NodeEventHandlerOptions,
  source?: NodeEventSessionSource,
): Promise<NodeEventHandleResult | undefined> {
  if (!(await isNodeEventConnectionCurrent(opts))) {
    return pairingChangedResult(evt.event);
  }
  switch (evt.event) {
    case "node.desktop.availability": {
      const availability = parseNodeEventPayload(evt.payloadJSON);
      if (!Value.Check(DesktopAvailabilitySchema, availability)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const updated = ctx.updateNodeDesktopAvailability?.({
        nodeId,
        connId: opts?.connId,
        availability,
      });
      if (updated === null || updated === undefined) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      return {
        ok: true,
        event: evt.event,
        handled: true,
        reason: updated ? "updated" : "unchanged",
      };
    }
    case "voice.transcript": {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const text = normalizeOptionalString(obj.text) ?? "";
      if (!text) {
        return undefined;
      }
      if (text.length > 20_000) {
        return undefined;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? "";
      const cfg = getRuntimeConfig();
      const rawMainKey = normalizeMainKey(cfg.session?.mainKey);
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : rawMainKey;
      const { storePath, entry, canonicalKey } =
        source?.loaded ??
        (await loadGatewaySessionEntryReadOnlyInWorker({
          cfg,
          key: sessionKey,
          excludeInternalEffects: true,
        }));
      if (resolveAgentHarnessSessionContextError(canonicalKey, entry)) {
        return undefined;
      }
      const receivedAt = Date.now();
      const fingerprint = resolveVoiceTranscriptFingerprint(obj, text);
      const sessionId = entry?.sessionId ?? randomUUID();
      const runId = randomUUID();
      source?.assertCurrent();
      // Resolve reservations in receipt order so delayed currentness checks cannot
      // change the dedupe window, while rejected connections leave no committed state.
      const decision = createDeferredCore<VoiceTranscriptReservationAdmission>();
      const reservation: VoiceTranscriptReservation = {
        fingerprint,
        receivedAt,
        status: "pending",
        resolve: decision.resolve,
        rejectDecision: decision.reject,
        assertCurrent: source?.assertCurrent,
      };
      const queue = pendingVoiceTranscriptReservations.get(canonicalKey) ?? [];
      queue.push(reservation);
      pendingVoiceTranscriptReservations.set(canonicalKey, queue);

      const drain = () => {
        while (queue[0]?.status === "rejected") {
          queue.shift()?.resolve(null);
        }
        const next = queue[0];
        if (!next) {
          pendingVoiceTranscriptReservations.delete(canonicalKey);
          return;
        }
        if (next.status !== "ready") {
          return;
        }
        next.status = "checking";
        void (async () => {
          try {
            const isCurrent = next.isConnectionCurrent ? await next.isConnectionCurrent() : true;
            next.assertCurrent?.();
            const admission =
              isCurrent &&
              !shouldDropDuplicateVoiceTranscript({
                sessionKey: canonicalKey,
                fingerprint: next.fingerprint,
                now: next.receivedAt,
              }) &&
              next.start
                ? { work: next.start() }
                : null;
            next.resolve(admission);
          } catch (err) {
            next.rejectDecision(err);
          } finally {
            queue.shift();
            drain();
          }
        })();
      };
      const settle = (status: "ready" | "rejected") => {
        if (reservation.status !== "pending") {
          return;
        }
        reservation.status = status;
        drain();
      };

      const isConnectionCurrent = opts?.isConnectionCurrent;
      const voiceWork = runWithGatewayIndependentRootWorkContinuation(async () => {
        if (isConnectionCurrent && !(await isConnectionCurrent())) {
          settle("rejected");
          return;
        }
        reservation.isConnectionCurrent = isConnectionCurrent;
        reservation.start = () => {
          const touch = queueSessionStoreTouch({
            ctx,
            storePath,
            canonicalKey,
            sessionId,
            now: receivedAt,
            assertCurrent: source?.assertCurrent,
            isConnectionCurrent: opts?.isConnectionCurrent,
          });

          source?.pending.push(touch);

          // Voice now has a unique per-turn run id, so it is also the stable
          // client identity for chat streaming and abort lifecycle ownership.
          ctx.addChatRun(runId, {
            sessionKey: canonicalKey,
            clientRunId: runId,
          });
          return agentCommandFromIngress(
            {
              runId,
              message: text,
              sessionId,
              sessionKey: canonicalKey,
              thinking: "low",
              deliver: false,
              messageChannel: "node",
              inputProvenance: {
                kind: "external_user",
                sourceChannel: "voice",
                sourceTool: "gateway.voice.transcript",
              },
              allowModelOverride: false,
            },
            defaultRuntime,
            ctx.deps,
          );
        };
        settle("ready");
        const admission = await decision.promise;
        if (!admission) {
          return;
        }
        await admission.work;
      }, "node-events:voice-turn").catch((err: unknown) => {
        settle("rejected");
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      source?.pending.push(voiceWork);
      return undefined;
    }
    case "agent.request": {
      if (!evt.payloadJSON) {
        return undefined;
      }
      type AgentDeepLink = {
        message?: string;
        sessionKey?: string | null;
        thinking?: string | null;
        deliver?: boolean;
        attachments?: Array<{
          type?: string;
          mimeType?: string;
          fileName?: string;
          content?: unknown;
        }> | null;
        receipt?: boolean;
        receiptText?: string | null;
        to?: string | null;
        channel?: string | null;
        timeoutSeconds?: number | null;
        key?: string | null;
      };

      let link: AgentDeepLink | null;
      try {
        link = JSON.parse(evt.payloadJSON) as AgentDeepLink;
      } catch {
        return undefined;
      }

      const sessionKeyRaw = (link?.sessionKey ?? "").trim();
      const sessionKey = sessionKeyRaw.length > 0 ? sessionKeyRaw : `node-${nodeId}`;
      const cfg = getRuntimeConfig();
      const {
        storePath,
        entry,
        canonicalKey,
        agentId: sessionAgentId,
      } = source?.loaded ??
      (await loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: sessionKey,
        excludeInternalEffects: true,
      }));
      if (resolveAgentHarnessSessionContextError(canonicalKey, entry)) {
        return undefined;
      }

      let message = (link?.message ?? "").trim();
      let transcriptMessage = message;
      const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
        link?.attachments ?? undefined,
      );
      let images: Awaited<ReturnType<typeof parseMessageWithAttachments>>["images"] = [];
      let imageOrder: PromptImageOrderEntry[] = [];
      let offloadedRefs: Awaited<ReturnType<typeof parseMessageWithAttachments>>["offloadedRefs"] =
        [];
      if (!message && normalizedAttachments.length === 0) {
        return undefined;
      }
      if (message.length > 20_000) {
        return undefined;
      }
      if (normalizedAttachments.length > 0) {
        const modelRef = resolveSessionModelRef(cfg, entry, sessionAgentId);
        const supportsInlineImages = await resolveGatewayModelSupportsImages({
          loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
          loadGatewayModelCatalogSnapshot: ctx.loadGatewayModelCatalogSnapshot,
          agentId: sessionAgentId,
          provider: modelRef.provider,
          model: modelRef.model,
        });
        if (!(await isNodeEventConnectionCurrent(opts))) {
          return pairingChangedResult(evt.event);
        }
        try {
          const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
            maxBytes: resolveChatAttachmentMaxBytes(cfg),
            log: ctx.logGateway,
            supportsInlineImages,
            // server-node-events dispatches via agentCommandFromIngress which
            // has no structured media wiring; reject non-image attachments
            // explicitly rather than saving them where the agent cannot reach them.
            acceptNonImage: false,
          });
          if (!(await isNodeEventConnectionCurrent(opts))) {
            await cleanupNodeEventMedia(parsed.offloadedRefs ?? [], ctx);
            return pairingChangedResult(evt.event);
          }
          message = parsed.message.trim();
          images = parsed.images;
          imageOrder = parsed.imageOrder;
          offloadedRefs = parsed.offloadedRefs;
          if (message.length > 20_000) {
            ctx.logGateway.warn(
              `agent.request message exceeds limit after attachment parsing (length=${message.length})`,
            );
            if (parsed.offloadedRefs && parsed.offloadedRefs.length > 0) {
              await cleanupNodeEventMedia(parsed.offloadedRefs, ctx);
            }
            return undefined;
          }
        } catch (err) {
          ctx.logGateway.warn(`agent.request attachment parse failed: ${formatErrorMessage(err)}`);
          return undefined;
        }
      }

      if (!message && images.length === 0) {
        return undefined;
      }

      const channelRaw = normalizeOptionalString(link?.channel) ?? "";
      let channel = normalizeChannelId(channelRaw) ?? undefined;
      let to = normalizeOptionalString(link?.to);
      const deliverRequested = Boolean(link?.deliver);
      const wantsReceipt = Boolean(link?.receipt);
      const receiptText =
        normalizeOptionalString(link?.receiptText) ||
        "Just received your iOS share + request, working on it.";

      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(offloadedRefs ?? [], ctx);
        return pairingChangedResult(evt.event);
      }
      await touchSessionStore({
        storePath,
        canonicalKey,
        sessionId,
        now,
        assertCurrent: source?.assertCurrent,
      });
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(offloadedRefs ?? [], ctx);
        return pairingChangedResult(evt.event);
      }

      if (deliverRequested && (!channel || !to)) {
        const entryContext = deliveryContextFromSession(entry);
        const entryChannel = entryContext?.channel
          ? normalizeChannelId(entryContext.channel)
          : undefined;
        const entryTo = normalizeOptionalString(entryContext?.to) ?? "";
        if (!channel && entryChannel) {
          channel = entryChannel;
        }
        if (!to && entryTo) {
          to = entryTo;
        }
      }
      const deliver = deliverRequested && Boolean(channel && to);
      const deliveryChannel = deliver ? channel : undefined;
      const deliveryTo = deliver ? to : undefined;
      if (deliverRequested && !deliver) {
        ctx.logGateway.warn(
          `agent delivery disabled node=${nodeId}: missing session delivery route (channel=${channel ?? "-"} to=${to ?? "-"})`,
        );
      }

      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(offloadedRefs ?? [], ctx);
        return pairingChangedResult(evt.event);
      }
      const persistedTranscriptMedia = await persistInboundImagesForTranscript({
        images,
        offloadedRefs,
        log: ctx.logGateway,
        logContext: "agent.request",
      });
      if (!(await isNodeEventConnectionCurrent(opts))) {
        await cleanupNodeEventMedia(persistedTranscriptMedia.entries, ctx);
        return pairingChangedResult(evt.event);
      }
      if (persistedTranscriptMedia.omission === "inline-image-save-failed") {
        transcriptMessage = [transcriptMessage, INLINE_IMAGE_DURABLE_OMISSION_MARKER]
          .filter(Boolean)
          .join("\n");
      }
      const transcriptMedia = persistedTranscriptMedia.entries.map((media) => media.fact);

      if (wantsReceipt && deliveryChannel && deliveryTo) {
        // Delivery stays detached from agent startup, but remains part of the
        // accepted node request until the durable send settles.
        const receipt = runWithGatewayIndependentRootWorkContinuation(async () => {
          if (!(await isNodeEventConnectionCurrent(opts))) {
            return;
          }
          const receiptDeps = ctx.deps;
          const resolved = await resolveOutboundTarget({
            channel: deliveryChannel,
            to: deliveryTo,
            cfg,
            mode: "explicit",
          });
          if (!resolved.ok) {
            throw new Error(String(resolved.error));
          }
          const session = buildOutboundSessionContext({
            cfg,
            sessionKey: canonicalKey,
          });
          const send = await sendDurableMessageBatchCore({
            cfg,
            channel: deliveryChannel,
            to: resolved.to,
            payloads: [{ text: receiptText }],
            session,
            bestEffort: true,
            durability: "best_effort",
            deps: createOutboundSendDeps(receiptDeps),
          });
          if (send.status === "failed") {
            throw send.error;
          }
        }, "node-events:delivery").catch((err: unknown) => {
          ctx.logGateway.warn(`agent receipt failed node=${nodeId}: ${formatForLog(err)}`);
        });
        source?.pending.push(receipt);
      } else if (wantsReceipt) {
        ctx.logGateway.warn(
          `agent receipt skipped node=${nodeId}: missing delivery route (channel=${deliveryChannel ?? "-"} to=${deliveryTo ?? "-"})`,
        );
      }

      source?.assertCurrent();
      const nodeAgentInput: NodeAgentCommandInput = {
        runId: sessionId,
        message,
        images,
        imageOrder,
        ...(transcriptMedia.length > 0 ||
        persistedTranscriptMedia.omission === "inline-image-save-failed"
          ? { transcriptMessage, ...(transcriptMedia.length > 0 ? { transcriptMedia } : {}) }
          : {}),
        sessionId,
        sessionKey: canonicalKey,
        thinking: link?.thinking ?? undefined,
        deliver,
        to: deliveryTo,
        channel: deliveryChannel,
        timeout:
          typeof link?.timeoutSeconds === "number" ? link.timeoutSeconds.toString() : undefined,
        messageChannel: "node",
        allowModelOverride: false,
      };
      const nodeAdmissionConnectionCurrent = opts?.isConnectionCurrent;
      const onNodeAdmissionRejected = () =>
        cleanupNodeEventMedia(persistedTranscriptMedia.entries, ctx);
      // The node RPC can finish before the agent starts its own session admission.
      // Reserve a root now so suspension cannot acknowledge and then strand the turn,
      // but recheck the admitted connection before agent work actually starts.
      const agentWork = runWithGatewayIndependentRootWorkContinuation(async () => {
        if (nodeAdmissionConnectionCurrent && !(await nodeAdmissionConnectionCurrent())) {
          await onNodeAdmissionRejected();
          return;
        }
        await agentCommandFromIngress(nodeAgentInput, defaultRuntime, ctx.deps);
      }, "node-events:agent-turn").catch((err: unknown) => {
        ctx.logGateway.warn(`agent failed node=${nodeId}: ${formatForLog(err)}`);
      });
      source?.pending.push(agentWork);
      return undefined;
    }
    case "notifications.changed":
      return handleNodeNotificationEvent(ctx, nodeId, evt, opts, source);
    case "chat.subscribe":
    case "chat.unsubscribe": {
      const sessionKey = normalizeOptionalString(
        parseNodeEventPayload(evt.payloadJSON)?.sessionKey,
      );
      if (!sessionKey) {
        return undefined;
      }
      const { canonicalKey } = resolveSessionStoreIdentity({ cfg: getRuntimeConfig(), sessionKey });
      // Fanout is keyed by the canonical session; retain the connection owner for safe reconnect.
      if (evt.event === "chat.subscribe") {
        await ctx.nodeSubscribe(nodeId, canonicalKey, opts?.connId);
      } else {
        await ctx.nodeUnsubscribe(nodeId, canonicalKey, opts?.connId);
      }
      return undefined;
    }
    case "exec.started":
    case "exec.finished":
    case "exec.denied": {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const sessionKeyRaw = normalizeOptionalString(obj.sessionKey) ?? `node-${nodeId}`;
      const config = captureNodeEventConfig();
      const { cfg } = config;
      const { canonicalKey: sessionKey, agentId } = resolveSessionStoreIdentity({
        cfg,
        sessionKey: sessionKeyRaw,
      });
      const runId = normalizeOptionalString(obj.runId) ?? "";
      const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
      const eventSessionKey = resolveEventSessionKeyForPolicy(sessionKey, policy);
      const assertAcceptanceCurrent = () => {
        config.assertCurrent();
        opts?.assertSessionEventCurrent?.();
      };
      assertAcceptanceCurrent();
      const auth = ctx.authorizeNodeSystemRunEvent({
        nodeId,
        connId: opts?.connId,
        ...(runId ? { runId } : {}),
        sessionKey: sessionKeyRaw,
        event: evt.event,
      });
      if (!auth) {
        return {
          ok: true,
          event: evt.event,
          handled: false,
          reason: "unmatched_exec_event",
        };
      }
      if (cfg.tools?.exec?.notifyOnExit === false || obj.suppressNotifyOnExit === true) {
        return undefined;
      }
      if (evt.event === "exec.denied") {
        return undefined;
      }
      const command = normalizeOptionalString(obj.command) ?? "";
      const exitCode =
        typeof obj.exitCode === "number" && Number.isFinite(obj.exitCode)
          ? obj.exitCode
          : undefined;
      const timedOut = obj.timedOut === true;
      const output = normalizeOptionalString(obj.output) ?? "";

      let text;
      if (evt.event === "exec.started") {
        text = `Exec started (node=${nodeId}${runId ? ` id=${runId}` : ""})`;
        if (command) {
          text += `: ${command}`;
        }
      } else {
        const exitLabel = timedOut ? "timeout" : `code ${exitCode ?? "?"}`;
        const compactOutput = compactNodeEventText(output, MAX_EXEC_EVENT_OUTPUT_CHARS);
        const shouldNotify = timedOut || exitCode !== 0 || compactOutput.length > 0;
        if (!shouldNotify) {
          return undefined;
        }
        text = `Exec finished (node=${nodeId}${runId ? ` id=${runId}` : ""}, ${exitLabel})`;
        if (compactOutput) {
          text += `\n${compactOutput}`;
        }
      }

      const notify = async () => {
        const expectedTarget = await captureSessionEventTargetForHost(agentId, eventSessionKey, {
          assertCaptureCurrent: assertAcceptanceCurrent,
        });
        if (!(await isNodeEventConnectionCurrent(opts))) {
          return pairingChangedResult(evt.event);
        }
        assertAcceptanceCurrent();
        if (
          evt.event === "exec.finished" &&
          runId &&
          shouldDropDuplicateExecFinished({ sessionKey, runId, now: Date.now() })
        ) {
          return undefined;
        }
        const receipt = enqueueNodeExecNotice({
          sessionKey: eventSessionKey,
          agentId,
          authorization: auth,
          runId,
          text,
          expectedTarget,
          // The registry accepted this notice before the node connection could depart.
          assertAcceptanceCurrent: config.assertCurrent,
        });
        if (receipt) {
          const accepted = await receipt.accepted;
          if (!accepted.ok) {
            throw new Error(accepted.error);
          }
          void receipt.settled.then((outcome) => {
            if (outcome.status !== "completed") {
              ctx.logGateway.warn(`exec event not delivered node=${nodeId}: ${outcome.status}`);
            }
          });
        }
        return undefined;
      };
      // A caller still waiting on this run gets its output inline; notify only if that fails.
      if (typeof auth === "object" && auth.holdNotice) {
        auth.holdNotice(() => {
          void notify().catch((error: unknown) => {
            ctx.logGateway.warn(
              `exec event not delivered node=${nodeId}: ${formatErrorMessage(error)}`,
            );
          });
        });
      } else {
        return await notify();
      }
      return undefined;
    }
    case "push.apns.register": {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return undefined;
      }
      const result = await registerNodeApnsEvent(ctx, nodeId, obj, opts);
      return result === "pairing-changed" ? pairingChangedResult(evt.event) : undefined;
    }
    case NODE_HOST_STATS_EVENT: {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj || !validateNodeHostStatsPayload(obj)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const hostStats = ctx.updateNodeHostStats?.({ nodeId, connId: opts?.connId, stats: obj });
      if (!hostStats) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      ctx.broadcast("node.hostStats", { nodeId, hostStats }, { dropIfSlow: true });
      return { ok: true, event: evt.event, handled: true, reason: "updated" };
    }
    case NODE_PRESENCE_ACTIVITY_EVENT: {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj || !validateNodePresenceActivityPayload(obj)) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      if ("action" in obj) {
        const cleared = ctx.clearNodePresenceActivity?.({ nodeId, connId: opts?.connId });
        if (cleared === null || cleared === undefined) {
          return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
        }
        if (cleared) {
          ctx.broadcast(
            "node.presence",
            { nodeId, lastActiveAtMs: null, presenceUpdatedAtMs: null },
            { dropIfSlow: true },
          );
        }
        return {
          ok: true,
          event: evt.event,
          handled: true,
          reason: cleared ? "cleared" : "already_clear",
        };
      }
      if (obj.source !== "app" && opts?.presenceAllowed !== true) {
        return { ok: true, event: evt.event, handled: false, reason: "permission_required" };
      }
      const updated = ctx.updateNodePresenceActivity?.({
        nodeId,
        connId: opts?.connId,
        ...obj,
      });
      if (!updated) {
        return { ok: true, event: evt.event, handled: false, reason: "stale_connection" };
      }
      ctx.broadcast("node.presence", { nodeId, ...updated }, { dropIfSlow: true });
      return { ok: true, event: evt.event, handled: true, reason: "updated" };
    }
    case NODE_PRESENCE_ALIVE_EVENT: {
      const obj = parseNodeEventPayload(evt.payloadJSON);
      if (!obj) {
        return { ok: true, event: evt.event, handled: false, reason: "invalid_payload" };
      }
      const deviceId = normalizeOptionalString(opts?.deviceId);
      if (!deviceId) {
        return { ok: true, event: evt.event, handled: false, reason: "missing_device_identity" };
      }
      const pairingGeneration = opts?.pairingGeneration;
      if (!pairingGeneration || pairingGeneration.nodeId !== deviceId) {
        return pairingChangedResult(evt.event);
      }
      const now = Date.now();
      const presenceOwnerKey = `${deviceId}\0${pairingGeneration.key}`;
      const lastPersistedAt = recentNodePresencePersistAt.get(presenceOwnerKey) ?? 0;
      if (now - lastPersistedAt < NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS) {
        return { ok: true, event: evt.event, handled: true, reason: "throttled" };
      }

      const lastSeenReason = normalizeNodePresenceAliveReason(obj.trigger);
      try {
        // Node last-seen lives on the device record; node.pair.list projects
        // it from there, so one write covers both surfaces.
        const deviceUpdated = await updatePairedDevicePresence(
          deviceId,
          {
            lastSeenAtMs: now,
            lastSeenReason,
          },
          pairingGeneration,
        );
        if (!deviceUpdated) {
          return pairingChangedResult(evt.event);
        }
        recentNodePresencePersistAt.set(presenceOwnerKey, now);
        pruneBoundedTimestampMap(recentNodePresencePersistAt, {
          now,
          ttlMs: NODE_PRESENCE_PERSIST_MIN_INTERVAL_MS * 10,
          maxEntries: MAX_RECENT_NODE_PRESENCE_KEYS,
        });
        return { ok: true, event: evt.event, handled: true, reason: "persisted" };
      } catch (err) {
        ctx.logGateway.warn(`node presence alive failed node=${nodeId}: ${formatForLog(err)}`);
        return { ok: true, event: evt.event, handled: false, reason: "persist_failed" };
      }
    }
    default:
      return { ok: true, event: evt.event, handled: false, reason: "unsupported_event" };
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
