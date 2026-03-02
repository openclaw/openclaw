import { randomUUID } from "node:crypto";
import { listAgentIds } from "../../agents/agent-scope.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { agentCommand } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
  resolveAgentMainSessionKey,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import { resolveAssistantAvatarUrl } from "../control-ui-shared.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import {
  canonicalizeSpawnedByForAgent,
  loadSessionEntry,
  pruneLegacyStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { sessionsHandlers } from "./sessions.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;

function isGatewayErrorShape(value: unknown): value is { code: string; message: string } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return typeof candidate.code === "string" && typeof candidate.message === "string";
}

async function runSessionResetFromAgent(params: {
  key: string;
  reason: "new" | "reset";
  idempotencyKey: string;
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
}): Promise<
  | { ok: true; key: string; sessionId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (
      result:
        | { ok: true; key: string; sessionId?: string }
        | { ok: false; error: ReturnType<typeof errorShape> },
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const respond: GatewayRequestHandlerOptions["respond"] = (ok, payload, error) => {
      if (!ok) {
        settle({
          ok: false,
          error: isGatewayErrorShape(error)
            ? error
            : errorShape(ErrorCodes.UNAVAILABLE, String(error ?? "sessions.reset failed")),
        });
        return;
      }
      const payloadObj = payload as
        | {
            key?: unknown;
            entry?: {
              sessionId?: unknown;
            };
          }
        | undefined;
      const key = typeof payloadObj?.key === "string" ? payloadObj.key : params.key;
      const sessionId =
        payloadObj?.entry && typeof payloadObj.entry.sessionId === "string"
          ? payloadObj.entry.sessionId
          : undefined;
      settle({ ok: true, key, sessionId });
    };

    const resetResult = sessionsHandlers["sessions.reset"]({
      req: {
        type: "req",
        id: `${params.idempotencyKey}:reset`,
        method: "sessions.reset",
      },
      params: {
        key: params.key,
        reason: params.reason,
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      respond,
    });

    void (async () => {
      try {
        await resetResult;
        if (!settled) {
          settle({
            ok: false,
            error: errorShape(
              ErrorCodes.UNAVAILABLE,
              "sessions.reset completed without returning a response",
            ),
          });
        }
      } catch (err: unknown) {
        settle({
          ok: false,
          error: errorShape(ErrorCodes.UNAVAILABLE, String(err)),
        });
      }
    })();
  });
}

export const agentHandlers: GatewayRequestHandlers = {
  agent: async ({ params, respond, context, client, isWebchatConnect }) => {
    const p = params;
    if (!validateAgentParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      message: string;
      agentId?: string;
      to?: string;
      replyTo?: string;
      sessionId?: string;
      sessionKey?: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      channel?: string;
      replyChannel?: string;
      accountId?: string;
      replyAccountId?: string;
      threadId?: string;
      groupId?: string;
      groupChannel?: string;
      groupSpace?: string;
      lane?: string;
      extraSystemPrompt?: string;
      internalEvents?: AgentInternalEvent[];
      idempotencyKey: string;
      timeout?: number;
      bestEffortDeliver?: boolean;
      label?: string;
      spawnedBy?: string;
      inputProvenance?: InputProvenance;
    };
    const cfg = loadConfig();
    const idem = request.idempotencyKey;
    const groupIdRaw = typeof request.groupId === "string" ? request.groupId.trim() : "";
    const groupChannelRaw =
      typeof request.groupChannel === "string" ? request.groupChannel.trim() : "";
    const groupSpaceRaw = typeof request.groupSpace === "string" ? request.groupSpace.trim() : "";
    let resolvedGroupId: string | undefined = groupIdRaw || undefined;
    let resolvedGroupChannel: string | undefined = groupChannelRaw || undefined;
    let resolvedGroupSpace: string | undefined = groupSpaceRaw || undefined;
    let spawnedByValue =
      typeof request.spawnedBy === "string" ? request.spawnedBy.trim() : undefined;
    const inputProvenance = normalizeInputProvenance(request.inputProvenance);
    const cached = context.dedupe.get(`agent:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);
    const requestedBestEffortDeliver =
      typeof request.bestEffortDeliver === "boolean" ? request.bestEffortDeliver : undefined;

    let message = (request.message ?? "").trim();
    let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    if (normalizedAttachments.length > 0) {
      try {
        const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
        });
        message = parsed.message.trim();
        images = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }

    const isKnownGatewayChannel = (value: string): boolean => isGatewayMessageChannel(value);
    const channelHints = [request.channel, request.replyChannel]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const rawChannel of channelHints) {
      const normalized = normalizeMessageChannel(rawChannel);
      if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown channel: ${String(normalized)}`,
          ),
        );
        return;
      }
    }

    const agentIdRaw = typeof request.agentId === "string" ? request.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (agentId) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown agent id "${request.agentId}"`,
          ),
        );
        return;
      }
    }

    const requestedSessionKeyRaw =
      typeof request.sessionKey === "string" && request.sessionKey.trim()
        ? request.sessionKey.trim()
        : undefined;
    if (
      requestedSessionKeyRaw &&
      classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent"
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: malformed session key "${requestedSessionKeyRaw}"`,
        ),
      );
      return;
    }
    let requestedSessionKey =
      requestedSessionKeyRaw ??
      resolveExplicitAgentSessionKey({
        cfg,
        agentId,
      });
    if (agentId && requestedSessionKeyRaw) {
      const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
      if (sessionAgentId !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`,
          ),
        );
        return;
      }
    }
    let resolvedSessionId = request.sessionId?.trim() || undefined;
    let sessionEntry: SessionEntry | undefined;
    let bestEffortDeliver = requestedBestEffortDeliver ?? false;
    let cfgForAgent: ReturnType<typeof loadConfig> | undefined;
    let resolvedSessionKey = requestedSessionKey;
    let skipTimestampInjection = false;

    const resetCommandMatch = message.match(RESET_COMMAND_RE);
    if (resetCommandMatch && requestedSessionKey) {
      const resetReason = resetCommandMatch[1]?.toLowerCase() === "new" ? "new" : "reset";
      const resetResult = await runSessionResetFromAgent({
        key: requestedSessionKey,
        reason: resetReason,
        idempotencyKey: idem,
        context,
        client,
        isWebchatConnect,
      });
      if (!resetResult.ok) {
        respond(false, undefined, resetResult.error);
        return;
      }
      requestedSessionKey = resetResult.key;
      resolvedSessionId = resetResult.sessionId ?? resolvedSessionId;
      const postResetMessage = resetCommandMatch[2]?.trim() ?? "";
      if (postResetMessage) {
        message = postResetMessage;
      } else {
        // Keep bare /new and /reset behavior aligned with chat.send:
        // reset first, then run a fresh-session greeting prompt in-place.
        message = BARE_SESSION_RESET_PROMPT;
        skipTimestampInjection = true;
      }
    }

    // Inject timestamp into user-authored messages that don't already have one.
    // Channel messages (Discord, Telegram, etc.) get timestamps via envelope
    // formatting in a separate code path — they never reach this handler.
    // See: https://github.com/moltbot/moltbot/issues/3658
    if (!skipTimestampInjection) {
      message = injectTimestamp(message, timestampOptsFromConfig(cfg));
    }

    if (requestedSessionKey) {
      const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
      cfgForAgent = cfg;
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      const labelValue = request.label?.trim() || entry?.label;
      const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
      spawnedByValue = canonicalizeSpawnedByForAgent(
        cfg,
        sessionAgent,
        spawnedByValue || entry?.spawnedBy,
      );
      let inheritedGroup:
        | { groupId?: string; groupChannel?: string; groupSpace?: string }
        | undefined;
      if (spawnedByValue && (!resolvedGroupId || !resolvedGroupChannel || !resolvedGroupSpace)) {
        try {
          const parentEntry = loadSessionEntry(spawnedByValue)?.entry;
          inheritedGroup = {
            groupId: parentEntry?.groupId,
            groupChannel: parentEntry?.groupChannel,
            groupSpace: parentEntry?.space,
          };
        } catch {
          inheritedGroup = undefined;
        }
      }
      resolvedGroupId = resolvedGroupId || inheritedGroup?.groupId;
      resolvedGroupChannel = resolvedGroupChannel || inheritedGroup?.groupChannel;
      resolvedGroupSpace = resolvedGroupSpace || inheritedGroup?.groupSpace;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      const nextEntryPatch: SessionEntry = {
        sessionId,
        updatedAt: now,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        systemSent: entry?.systemSent,
        sendPolicy: entry?.sendPolicy,
        skillsSnapshot: entry?.skillsSnapshot,
        deliveryContext: deliveryFields.deliveryContext,
        lastChannel: deliveryFields.lastChannel ?? entry?.lastChannel,
        lastTo: deliveryFields.lastTo ?? entry?.lastTo,
        lastAccountId: deliveryFields.lastAccountId ?? entry?.lastAccountId,
        modelOverride: entry?.modelOverride,
        providerOverride: entry?.providerOverride,
        label: labelValue,
        spawnedBy: spawnedByValue,
        spawnDepth: entry?.spawnDepth,
        channel: entry?.channel ?? request.channel?.trim(),
        groupId: resolvedGroupId ?? entry?.groupId,
        groupChannel: resolvedGroupChannel ?? entry?.groupChannel,
        space: resolvedGroupSpace ?? entry?.space,
        cliSessionIds: entry?.cliSessionIds,
        claudeCliSessionId: entry?.claudeCliSessionId,
      };
      sessionEntry = mergeSessionEntry(entry, nextEntryPatch);
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry,
        sessionKey: canonicalKey,
        channel: entry?.channel,
        chatType: entry?.chatType,
      });
      if (sendPolicy === "deny") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
        );
        return;
      }
      resolvedSessionId = sessionId;
      const canonicalSessionKey = canonicalKey;
      resolvedSessionKey = canonicalSessionKey;
      const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
      const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      if (storePath) {
        const persisted = await updateSessionStore(storePath, (store) => {
          const target = resolveGatewaySessionStoreTarget({
            cfg,
            key: requestedSessionKey,
            store,
          });
          pruneLegacyStoreKeys({
            store,
            canonicalKey: target.canonicalKey,
            candidates: target.storeKeys,
          });
          const merged = mergeSessionEntry(store[canonicalSessionKey], nextEntryPatch);
          store[canonicalSessionKey] = merged;
          return merged;
        });
        sessionEntry = persisted;
      }
      if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
        context.addChatRun(idem, {
          sessionKey: canonicalSessionKey,
          clientRunId: idem,
        });
        if (requestedBestEffortDeliver === undefined) {
          bestEffortDeliver = true;
        }
      }
      registerAgentRunContext(idem, { sessionKey: canonicalSessionKey });
    }

    const runId = idem;
    const connId = typeof client?.connId === "string" ? client.connId : undefined;
    const wantsToolEvents = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    );
    if (connId && wantsToolEvents) {
      context.registerToolEventRecipient(runId, connId);
      // Register for any other active runs *in the same session* so
      // late-joining clients (e.g. page refresh mid-response) receive
      // in-progress tool events without leaking cross-session data.
      for (const [activeRunId, active] of context.chatAbortControllers) {
        if (activeRunId !== runId && active.sessionKey === requestedSessionKey) {
          context.registerToolEventRecipient(activeRunId, connId);
        }
      }
    }

    const wantsDelivery = request.deliver === true;
    const explicitTo =
      typeof request.replyTo === "string" && request.replyTo.trim()
        ? request.replyTo.trim()
        : typeof request.to === "string" && request.to.trim()
          ? request.to.trim()
          : undefined;
    const explicitThreadId =
      typeof request.threadId === "string" && request.threadId.trim()
        ? request.threadId.trim()
        : undefined;
    const turnSourceChannel =
      typeof request.channel === "string" && request.channel.trim()
        ? request.channel.trim()
        : undefined;
    const turnSourceTo =
      typeof request.to === "string" && request.to.trim() ? request.to.trim() : undefined;
    const turnSourceAccountId =
      typeof request.accountId === "string" && request.accountId.trim()
        ? request.accountId.trim()
        : undefined;
    const deliveryPlan = resolveAgentDeliveryPlan({
      sessionEntry,
      requestedChannel: request.replyChannel ?? request.channel,
      explicitTo,
      explicitThreadId,
      accountId: request.replyAccountId ?? request.accountId,
      wantsDelivery,
      turnSourceChannel,
      turnSourceTo,
      turnSourceAccountId,
      turnSourceThreadId: explicitThreadId,
    });

    let resolvedChannel = deliveryPlan.resolvedChannel;
    let deliveryTargetMode = deliveryPlan.deliveryTargetMode;
    let resolvedAccountId = deliveryPlan.resolvedAccountId;
    let resolvedTo = deliveryPlan.resolvedTo;
    let effectivePlan = deliveryPlan;

    if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
      const cfgResolved = cfgForAgent ?? cfg;
      try {
        const selection = await resolveMessageChannelSelection({ cfg: cfgResolved });
        resolvedChannel = selection.channel;
        deliveryTargetMode = deliveryTargetMode ?? "implicit";
        effectivePlan = {
          ...deliveryPlan,
          resolvedChannel,
          deliveryTargetMode,
          resolvedAccountId,
        };
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }

    if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
      const cfgResolved = cfgForAgent ?? cfg;
      const fallback = resolveAgentOutboundTarget({
        cfg: cfgResolved,
        plan: effectivePlan,
        targetMode: deliveryTargetMode ?? "implicit",
        validateExplicitTarget: false,
      });
      if (fallback.resolvedTarget?.ok) {
        resolvedTo = fallback.resolvedTo;
      }
    }

    if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
        ),
      );
      return;
    }

    const normalizedTurnSource = normalizeMessageChannel(turnSourceChannel);
    const turnSourceMessageChannel =
      normalizedTurnSource && isGatewayMessageChannel(normalizedTurnSource)
        ? normalizedTurnSource
        : undefined;
    const originMessageChannel =
      turnSourceMessageChannel ??
      (client?.connect && isWebchatConnect(client.connect)
        ? INTERNAL_MESSAGE_CHANNEL
        : resolvedChannel);

    const deliver = request.deliver === true && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;

    const accepted = {
      runId,
      status: "accepted" as const,
      acceptedAt: Date.now(),
    };
    // Store an in-flight ack so retries do not spawn a second run.
    context.dedupe.set(`agent:${idem}`, {
      ts: Date.now(),
      ok: true,
      payload: accepted,
    });
    respond(true, accepted, undefined, { runId });

    const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;

    void agentCommand(
      {
        message,
        images,
        to: resolvedTo,
        sessionId: resolvedSessionId,
        sessionKey: resolvedSessionKey,
        thinking: request.thinking,
        deliver,
        deliveryTargetMode,
        channel: resolvedChannel,
        accountId: resolvedAccountId,
        threadId: resolvedThreadId,
        runContext: {
          messageChannel: originMessageChannel,
          accountId: resolvedAccountId,
          groupId: resolvedGroupId,
          groupChannel: resolvedGroupChannel,
          groupSpace: resolvedGroupSpace,
          currentThreadTs: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
        },
        groupId: resolvedGroupId,
        groupChannel: resolvedGroupChannel,
        groupSpace: resolvedGroupSpace,
        spawnedBy: spawnedByValue,
        timeout: request.timeout?.toString(),
        bestEffortDeliver,
        messageChannel: originMessageChannel,
        runId,
        lane: request.lane,
        extraSystemPrompt: request.extraSystemPrompt,
        internalEvents: request.internalEvents,
        inputProvenance,
      },
      defaultRuntime,
      context.deps,
    )
      .then((result) => {
        const payload = {
          runId,
          status: "ok" as const,
          summary: "completed",
          result,
        };
        context.dedupe.set(`agent:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        // Send a second res frame (same id) so TS clients with expectFinal can wait.
        // Swift clients will typically treat the first res as the result and ignore this.
        respond(true, payload, undefined, { runId });
      })
      .catch((err) => {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        const payload = {
          runId,
          status: "error" as const,
          summary: String(err),
        };
        context.dedupe.set(`agent:${idem}`, {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        });
        respond(false, payload, error, {
          runId,
          error: formatForLog(err),
        });
      });
  },
  "agent.identity.get": ({ params, respond }) => {
    if (!validateAgentIdentityParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: ${formatValidationErrors(
            validateAgentIdentityParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params;
    const agentIdRaw = typeof p.agentId === "string" ? p.agentId.trim() : "";
    const sessionKeyRaw = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (sessionKeyRaw) {
      if (classifySessionKeyShape(sessionKeyRaw) === "malformed_agent") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: malformed session key "${sessionKeyRaw}"`,
          ),
        );
        return;
      }
      const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
      if (agentId && resolved !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`,
          ),
        );
        return;
      }
      agentId = resolved;
    }
    const cfg = loadConfig();
    const identity = resolveAssistantIdentity({ cfg, agentId });
    const avatarValue =
      resolveAssistantAvatarUrl({
        avatar: identity.avatar,
        agentId: identity.agentId,
        basePath: cfg.gateway?.controlUi?.basePath,
      }) ?? identity.avatar;
    respond(true, { ...identity, avatar: avatarValue }, undefined);
  },
  "agent.wait": async ({ params, respond }) => {
    if (!validateAgentWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const runId = (p.runId ?? "").trim();
    const timeoutMs =
      typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
        ? Math.max(0, Math.floor(p.timeoutMs))
        : 30_000;

    const snapshot = await waitForAgentJob({
      runId,
      timeoutMs,
    });
    if (!snapshot) {
      respond(true, {
        runId,
        status: "timeout",
      });
      return;
    }
    respond(true, {
      runId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      error: snapshot.error,
    });
  },
};
