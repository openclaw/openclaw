import { randomUUID } from "node:crypto";
import { listAgentIds } from "../../agents/agent-scope.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import {
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSpawnedRun,
} from "../../agents/spawned-context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { buildBareSessionResetPrompt } from "../../auto-reply/reply/session-reset-prompt.js";
import type { ChannelOutboundTargetMode } from "../../channels/plugins/types.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
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
import { abortAgentRunById, resolveAgentRunExpiresAtMs } from "../agent-abort.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import { resolveAssistantAvatarUrl } from "../control-ui-shared.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentAbortParams,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import {
  canonicalizeSpawnedByForAgent,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import {
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  type AgentWaitTerminalSnapshot,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;

function resolveSenderIsOwnerFromClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

async function runSessionResetFromAgent(params: {
  key: string;
  reason: "new" | "reset";
}): Promise<
  | { ok: true; key: string; sessionId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const result = await performGatewaySessionReset({
    key: params.key,
    reason: params.reason,
    commandSource: "gateway:agent",
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    key: result.key,
    sessionId: result.entry.sessionId,
  };
}

function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromIngress>[0];
  runId: string;
  idempotencyKey: string;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  void agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps)
    .then((result) => {
      const payload = {
        runId: params.runId,
        status: "ok" as const,
        summary: "completed",
        result,
      };
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `agent:${params.idempotencyKey}`,
        entry: {
          ts: Date.now(),
          ok: true,
          payload,
        },
      });
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.respond(true, payload, undefined, { runId: params.runId });
    })
    .catch((err) => {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: params.runId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `agent:${params.idempotencyKey}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      params.respond(false, payload, error, {
        runId: params.runId,
        error: formatForLog(err),
      });
    })
    .finally(() => {
      params.context.agentAbortControllers.delete(params.runId);
    });
}

function startAcceptedAgentRunFromGateway(params: {
  request: {
    thinking?: string;
    timeout?: number;
    lane?: string;
    extraSystemPrompt?: string;
    internalEvents?: AgentInternalEvent[];
    deliver?: boolean;
  };
  message: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  resolvedTo: string | undefined;
  resolvedSessionId: string | undefined;
  resolvedSessionKey: string | undefined;
  resolvedChannel: string;
  resolvedAccountId: string | undefined;
  resolvedThreadId: string | number | undefined;
  resolvedGroupId: string | undefined;
  resolvedGroupChannel: string | undefined;
  resolvedGroupSpace: string | undefined;
  deliveryTargetMode: ChannelOutboundTargetMode | undefined;
  originMessageChannel: string;
  spawnedByValue: string | undefined;
  sessionEntry: SessionEntry | undefined;
  senderIsOwner: boolean;
  inputProvenance: InputProvenance | undefined;
  bestEffortDeliver: boolean;
  resolvedTimeoutMs: number;
  runId: string;
  idempotencyKey: string;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  const deliver =
    params.request.deliver === true && params.resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;
  const accepted = {
    runId: params.runId,
    status: "accepted" as const,
    acceptedAt: Date.now(),
  };
  const agentAbortController = new AbortController();
  params.context.agentAbortControllers.set(params.runId, {
    controller: agentAbortController,
    sessionKey: params.resolvedSessionKey,
    startedAtMs: accepted.acceptedAt,
    expiresAtMs: resolveAgentRunExpiresAtMs({
      now: accepted.acceptedAt,
      timeoutMs: params.resolvedTimeoutMs,
    }),
  });
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `agent:${params.idempotencyKey}`,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: accepted,
    },
  });
  params.respond(true, accepted, undefined, { runId: params.runId });

  dispatchAgentRunFromGateway({
    ingressOpts: {
      message: params.message,
      images: params.images,
      to: params.resolvedTo,
      sessionId: params.resolvedSessionId,
      sessionKey: params.resolvedSessionKey,
      thinking: params.request.thinking,
      deliver,
      deliveryTargetMode: params.deliveryTargetMode,
      channel: params.resolvedChannel,
      accountId: params.resolvedAccountId,
      threadId: params.resolvedThreadId,
      runContext: {
        messageChannel: params.originMessageChannel,
        accountId: params.resolvedAccountId,
        groupId: params.resolvedGroupId,
        groupChannel: params.resolvedGroupChannel,
        groupSpace: params.resolvedGroupSpace,
        currentThreadTs:
          params.resolvedThreadId != null ? String(params.resolvedThreadId) : undefined,
      },
      groupId: params.resolvedGroupId,
      groupChannel: params.resolvedGroupChannel,
      groupSpace: params.resolvedGroupSpace,
      spawnedBy: params.spawnedByValue,
      timeout: params.request.timeout?.toString(),
      bestEffortDeliver: params.bestEffortDeliver,
      messageChannel: params.originMessageChannel,
      runId: params.runId,
      lane: params.request.lane,
      extraSystemPrompt: params.request.extraSystemPrompt,
      internalEvents: params.request.internalEvents,
      inputProvenance: params.inputProvenance,
      abortSignal: agentAbortController.signal,
      // Internal-only: allow workspace override for spawned subagent runs.
      workspaceDir: resolveIngressWorkspaceOverrideForSpawnedRun({
        spawnedBy: params.spawnedByValue,
        workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
      }),
      senderIsOwner: params.senderIsOwner,
    },
    runId: params.runId,
    idempotencyKey: params.idempotencyKey,
    respond: params.respond,
    context: params.context,
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
      inputProvenance?: InputProvenance;
    };
    const senderIsOwner = resolveSenderIsOwnerFromClient(client);
    const cfg = loadConfig();
    const idem = request.idempotencyKey;
    const normalizedSpawned = normalizeSpawnedRunMetadata({
      groupId: request.groupId,
      groupChannel: request.groupChannel,
      groupSpace: request.groupSpace,
    });
    let resolvedGroupId: string | undefined = normalizedSpawned.groupId;
    let resolvedGroupChannel: string | undefined = normalizedSpawned.groupChannel;
    let resolvedGroupSpace: string | undefined = normalizedSpawned.groupSpace;
    let spawnedByValue: string | undefined;
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
        // Date is embedded in the prompt so agents read the correct daily
        // memory files; skip further timestamp injection to avoid duplication.
        message = buildBareSessionResetPrompt(cfg);
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
      spawnedByValue = canonicalizeSpawnedByForAgent(cfg, sessionAgent, entry?.spawnedBy);
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
        fastMode: entry?.fastMode,
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
        spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
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
          const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
            cfg,
            key: requestedSessionKey,
            store,
          });
          const merged = mergeSessionEntry(store[primaryKey], nextEntryPatch);
          store[primaryKey] = merged;
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

    const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;
    const resolvedTimeoutMs = resolveAgentTimeoutMs({
      cfg: cfgForAgent ?? cfg,
      overrideSeconds: request.timeout,
    });

    startAcceptedAgentRunFromGateway({
      request,
      message,
      images,
      resolvedTo,
      resolvedSessionId,
      resolvedSessionKey,
      resolvedChannel,
      resolvedAccountId,
      resolvedThreadId,
      resolvedGroupId,
      resolvedGroupChannel,
      resolvedGroupSpace,
      deliveryTargetMode,
      originMessageChannel,
      spawnedByValue,
      sessionEntry,
      senderIsOwner,
      inputProvenance,
      bestEffortDeliver,
      resolvedTimeoutMs,
      runId,
      idempotencyKey: idem,
      respond,
      context,
    });
  },
  "agent.enqueue": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await agentHandlers.agent({ req, params, respond, context, client, isWebchatConnect });
  },
  "agent.abort": ({ params, respond, context }) => {
    if (!validateAgentAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.abort params: ${formatValidationErrors(validateAgentAbortParams.errors)}`,
        ),
      );
      return;
    }
    const request = params as { runId: string; sessionKey?: string };
    const runId = request.runId.trim();
    const sessionKey =
      typeof request.sessionKey === "string" && request.sessionKey.trim()
        ? request.sessionKey.trim()
        : undefined;
    const result = abortAgentRunById({
      agentAbortControllers: context.agentAbortControllers,
      runId,
      sessionKey,
      reason: "rpc",
    });
    respond(true, { ok: true, aborted: result.aborted, runId });
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
  "agent.wait": async ({ params, respond, context }) => {
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
    const hasActiveChatRun = context.chatAbortControllers.has(runId);

    const cachedGatewaySnapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe: context.dedupe,
      runId,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
    });
    if (cachedGatewaySnapshot) {
      respond(true, {
        runId,
        status: cachedGatewaySnapshot.status,
        startedAt: cachedGatewaySnapshot.startedAt,
        endedAt: cachedGatewaySnapshot.endedAt,
        error: cachedGatewaySnapshot.error,
      });
      return;
    }

    const lifecycleAbortController = new AbortController();
    const dedupeAbortController = new AbortController();
    const lifecyclePromise = waitForAgentJob({
      runId,
      timeoutMs,
      signal: lifecycleAbortController.signal,
      // When chat.send is active with the same runId, ignore cached lifecycle
      // snapshots so stale agent results do not preempt the active chat run.
      ignoreCachedSnapshot: hasActiveChatRun,
    });
    const dedupePromise = waitForTerminalGatewayDedupe({
      dedupe: context.dedupe,
      runId,
      timeoutMs,
      signal: dedupeAbortController.signal,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
    });

    const first = await Promise.race([
      lifecyclePromise.then((snapshot) => ({ source: "lifecycle" as const, snapshot })),
      dedupePromise.then((snapshot) => ({ source: "dedupe" as const, snapshot })),
    ]);

    let snapshot: AgentWaitTerminalSnapshot | Awaited<ReturnType<typeof waitForAgentJob>> =
      first.snapshot;
    if (snapshot) {
      if (first.source === "lifecycle") {
        dedupeAbortController.abort();
      } else {
        lifecycleAbortController.abort();
      }
    } else {
      snapshot = first.source === "lifecycle" ? await dedupePromise : await lifecyclePromise;
      lifecycleAbortController.abort();
      dedupeAbortController.abort();
    }

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
