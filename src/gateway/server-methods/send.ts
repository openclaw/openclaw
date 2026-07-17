// Send gateway methods route operator/tool messages and poll actions through
// channel plugins, outbound session state, durable delivery, and transcript mirrors.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateMessageActionParams,
  validatePollParams,
  validateSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { ToolAuthorizationError } from "../../agents/tools/common.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { sendDurableMessageBatch } from "../../channels/message/runtime.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import { createOutboundSendDeps } from "../../cli/deps.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  hydrateAttachmentParamsForAction,
  resolveAttachmentMediaPolicy,
} from "../../infra/outbound/message-action-params.js";
import {
  authorizePreparedMessageAction,
  buildCanonicalSendMessageActionInput,
  findMessageActionPolicyDenial,
  runMessageAction,
} from "../../infra/outbound/message-action-runner.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import {
  beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery,
  mirrorDeliveredSourceReplyToTranscript,
  reconcileTerminalSourceReplyDelivery,
} from "../../infra/outbound/source-reply-mirror.js";
import { maybeResolveIdLikeTarget } from "../../infra/outbound/target-resolver.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
} from "../../plugins/authorization-policy-context.js";
import type { AuthorizationInvocationContext } from "../../plugins/authorization-policy.types.js";
import { normalizePollInput } from "../../polls.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isAgentHarnessSessionKey,
  resolveMissingAgentHarnessSessionError,
} from "../../sessions/agent-harness-session-key.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseAgentSessionKey,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveGatewayConversationReadOrigin } from "../conversation-read-origin.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  resolveGatewayInflightRequest as resolveIdempotentGatewayRequest,
  runGatewayInflightWork,
  type GatewayInflightResult as InflightResult,
} from "./inflight.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

type MessageActionToolContext = Omit<ChannelThreadingToolContext, "currentChatType">;

function resolveTrustedAgentRuntimeMessageContext(params: {
  client: Parameters<GatewayRequestHandlers["message.action"]>[0]["client"];
}):
  | {
      ok: true;
      identityAgentId: string | undefined;
      identitySessionKey: string | undefined;
      toolContext: InternalChannelThreadingToolContext | undefined;
      requesterAccountId: string | undefined;
      requesterSenderId: string | undefined;
      requesterSenderIsOwner: boolean | undefined;
      requesterIsAuthorizedSender: boolean | undefined;
      requesterRoleIds: readonly string[] | undefined;
      sessionId: string | undefined;
      sourceReplyFinal: boolean | undefined;
      sourceReplyToolCallId: string | undefined;
    }
  | { ok: false; error: ReturnType<typeof errorShape> } {
  // Sender provenance and channel-read authority must come from the signed
  // ingress-issued turn context, never from request-controlled action fields.
  const identity = params.client?.internal?.agentRuntimeIdentity;
  const messageActionContext = identity?.messageActionContext;
  if (!identity) {
    return {
      ok: true,
      identityAgentId: undefined,
      identitySessionKey: undefined,
      toolContext: undefined,
      requesterAccountId: undefined,
      requesterSenderId: undefined,
      requesterSenderIsOwner: undefined,
      requesterIsAuthorizedSender: undefined,
      requesterRoleIds: undefined,
      sessionId: undefined,
      sourceReplyFinal: undefined,
      sourceReplyToolCallId: undefined,
    };
  }
  const identityAgentId = normalizeAgentId(identity.agentId);
  const identitySessionKey = identity.sessionKey.trim();
  if (!messageActionContext) {
    return {
      ok: true,
      identityAgentId,
      identitySessionKey,
      toolContext: undefined,
      requesterAccountId: undefined,
      requesterSenderId: undefined,
      requesterSenderIsOwner: undefined,
      requesterIsAuthorizedSender: undefined,
      requesterRoleIds: undefined,
      sessionId: undefined,
      sourceReplyFinal: undefined,
      sourceReplyToolCallId: undefined,
    };
  }
  if (Date.now() >= messageActionContext.expiresAtMs) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "agent runtime context has expired"),
    };
  }
  return {
    ok: true,
    identityAgentId,
    identitySessionKey,
    toolContext: messageActionContext.toolContext,
    requesterAccountId: messageActionContext.requesterAccountId,
    requesterSenderId: messageActionContext.requesterSenderId,
    requesterSenderIsOwner: messageActionContext.requesterSenderIsOwner,
    requesterIsAuthorizedSender: messageActionContext.requesterIsAuthorizedSender,
    requesterRoleIds: messageActionContext.requesterRoleIds,
    sessionId: messageActionContext.sessionId,
    sourceReplyFinal: messageActionContext.sourceReplyFinal,
    sourceReplyToolCallId: messageActionContext.sourceReplyToolCallId,
  };
}

function validateTrustedAgentRuntimeRequestIdentity(params: {
  trustedContext: Extract<
    ReturnType<typeof resolveTrustedAgentRuntimeMessageContext>,
    { ok: true }
  >;
  request: {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
  };
  requireSessionKey: boolean;
}): ReturnType<typeof errorShape> | undefined {
  const identityAgentId = params.trustedContext.identityAgentId;
  const identitySessionKey = params.trustedContext.identitySessionKey;
  if (!identityAgentId || !identitySessionKey) {
    return undefined;
  }
  const canonicalIdentitySessionKey =
    normalizeSessionKeyPreservingOpaquePeerIds(identitySessionKey);
  const requestSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(params.request.sessionKey);
  const requestAgentId = normalizeOptionalString(params.request.agentId);
  const sessionAgentId = parseAgentSessionKey(requestSessionKey)?.agentId;
  const requestSessionId = normalizeOptionalString(params.request.sessionId);
  if (
    (params.requireSessionKey && !requestSessionKey) ||
    (requestSessionKey && requestSessionKey !== canonicalIdentitySessionKey) ||
    (requestAgentId && normalizeAgentId(requestAgentId) !== identityAgentId) ||
    (sessionAgentId && normalizeAgentId(sessionAgentId) !== identityAgentId) ||
    (params.requireSessionKey &&
      params.trustedContext.sessionId &&
      requestSessionId !== params.trustedContext.sessionId)
  ) {
    return errorShape(
      ErrorCodes.INVALID_REQUEST,
      "agent runtime identity does not match the requested session",
    );
  }
  return undefined;
}

function resolveGatewayMessageActionAuthorizationContext(params: {
  client: Parameters<GatewayRequestHandlers["message.action"]>[0]["client"];
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  targetConversationId?: string;
  threadId?: string | number;
  trustedContext?: Extract<
    ReturnType<typeof resolveTrustedAgentRuntimeMessageContext>,
    { ok: true }
  >;
}): AuthorizationInvocationContext {
  const trusted = params.trustedContext;
  const sourceToolContext = trusted?.toolContext;
  const sourceConversationId =
    sourceToolContext?.currentChannelId ?? sourceToolContext?.currentMessagingTarget;
  const trustedSenderId = trusted?.requesterSenderId;
  const hasTrustedSender = Boolean(trustedSenderId);
  // A signed runtime may omit the optional turn session id, but it may never
  // replace that signed fact with a request-controlled value.
  const sessionId = trusted?.identityAgentId ? trusted.sessionId : params.sessionId;
  const principal = trustedSenderId
    ? createAuthorizationPrincipal({
        provider: sourceToolContext?.currentChannelProvider,
        accountId: trusted.requesterAccountId,
        senderId: trustedSenderId,
        senderIsOwner: trusted.requesterSenderIsOwner,
        isAuthorizedSender: trusted.requesterIsAuthorizedSender,
        roleIds: trusted.requesterRoleIds,
      })
    : trusted?.identityAgentId
      ? createAuthorizationPrincipal({ serviceId: "agent-runtime" })
      : params.client?.connect
        ? createAuthorizationPrincipal({
            operatorScopes: params.client.connect.scopes ?? [],
            operatorClientId: params.client.connect.client?.id,
            operatorDeviceId: params.client.connect.device?.id,
            operatorIsOwner: (params.client.connect.scopes ?? []).includes(ADMIN_SCOPE),
          })
        : createAuthorizationPrincipal({});
  return createAuthorizationInvocationContext({
    principal,
    agentId: trusted?.identityAgentId ?? params.agentId,
    sessionKey: trusted?.identitySessionKey ?? params.sessionKey,
    sessionId,
    conversationId: hasTrustedSender ? sourceConversationId : params.targetConversationId,
    threadId: hasTrustedSender
      ? sourceConversationId
        ? sourceToolContext?.currentThreadTs
        : undefined
      : params.threadId,
    trigger: "gateway",
  });
}

function resolveGatewayInflightRequest(params: {
  context: GatewayRequestContext;
  prefix: "message.action" | "poll" | "send";
  idempotencyKey: string;
  respond: RespondFn;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
}):
  | {
      kind: "ready";
      idem: string;
      dedupeKey: string;
      inflightMap: Map<string, Promise<InflightResult>>;
    }
  | {
      kind: "handled";
      done: Promise<void>;
    } {
  const idem = params.idempotencyKey;
  const dedupeKey =
    params.prefix === "message.action"
      ? `${params.prefix}:${params.conversationReadOrigin ?? "delegated"}:${idem}`
      : `${params.prefix}:${idem}`;
  return resolveIdempotentGatewayRequest({
    context: params.context,
    dedupeKey,
    idempotencyKey: idem,
    respond: params.respond,
  });
}

async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  context: GatewayRequestContext;
  rejectWebchatAsInternalOnly?: boolean;
}): Promise<
  | {
      cfg: OpenClawConfig;
      sourceCfg: OpenClawConfig;
      channel: string;
    }
  | {
      error: ReturnType<typeof errorShape>;
    }
> {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeMessageChannel(channelInput) : undefined;
  if (params.rejectWebchatAsInternalOnly && normalizedChannel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
      ),
    };
  }
  if (channelInput && !normalizedChannel) {
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const sourceCfg = params.context.getRuntimeConfig();
  const cfg = resolveGatewayPluginConfig({
    config: sourceCfg,
  });
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, sourceCfg, channel };
}

async function resolveInternalDeliveryChannel(
  requestChannel: unknown,
  context: GatewayRequestContext,
): Promise<
  | {
      kind: "ready";
      cfg: OpenClawConfig;
      sourceCfg: OpenClawConfig;
      channel: string;
    }
  | {
      kind: "failed";
      result: InflightResult;
    }
> {
  const resolvedChannel = await resolveRequestedChannel({
    requestChannel,
    unsupportedMessage: (input) => `unsupported channel: ${input}`,
    context,
    rejectWebchatAsInternalOnly: true,
  });
  if ("error" in resolvedChannel) {
    return {
      kind: "failed",
      result: { ok: false, error: resolvedChannel.error },
    };
  }
  return { kind: "ready", ...resolvedChannel };
}

function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: OpenClawConfig;
  accountId?: string;
}):
  | {
      ok: true;
      to: string;
    }
  | {
      ok: false;
      error: ReturnType<typeof errorShape>;
    } {
  const resolved = resolveOutboundTarget({
    channel: params.channel,
    to: params.to,
    cfg: params.cfg,
    accountId: params.accountId,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
    };
  }
  return { ok: true, to: resolved.to };
}

function resolveMessageActionRuntimeConfig(params: {
  cfg: OpenClawConfig;
  sourceCfg: OpenClawConfig;
}): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfig || !runtimeSourceConfig) {
    return params.cfg;
  }
  const selected = selectApplicableRuntimeConfig({
    inputConfig: params.sourceCfg,
    runtimeConfig,
    runtimeSourceConfig,
  });
  // Message actions must use the hot runtime snapshot when it matches the caller's source config.
  if (selected === runtimeConfig && selected !== params.cfg) {
    return resolveGatewayPluginConfig({ config: selected });
  }
  return params.cfg;
}

function buildGatewayDeliveryPayload(params: {
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: params.runId,
    messageId: params.result.messageId,
    channel: params.channel,
  };
  if ("chatId" in params.result) {
    payload.chatId = params.result.chatId;
  }
  if ("channelId" in params.result) {
    payload.channelId = params.result.channelId;
  }
  if ("toJid" in params.result) {
    payload.toJid = params.result.toJid;
  }
  if ("conversationId" in params.result) {
    payload.conversationId = params.result.conversationId;
  }
  if ("pollId" in params.result) {
    payload.pollId = params.result.pollId;
  }
  return payload;
}

function cacheGatewayDedupeSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: true,
    payload: params.payload,
  });
}

function cacheGatewayDedupeFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  error: ReturnType<typeof errorShape>;
}) {
  params.context.dedupe.set(params.dedupeKey, {
    ts: Date.now(),
    ok: false,
    error: params.error,
  });
}

function createGatewayInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  payload: unknown;
  channel: string;
}): InflightResult {
  cacheGatewayDedupeSuccess({
    context: params.context,
    dedupeKey: params.dedupeKey,
    payload: params.payload,
  });
  return {
    ok: true,
    payload: params.payload,
    meta: { channel: params.channel },
  };
}

function createGatewayDeliveryInflightSuccess(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  runId: string;
  channel: string;
  result: Record<string, unknown>;
}): InflightResult {
  return createGatewayInflightSuccess({
    context: params.context,
    dedupeKey: params.dedupeKey,
    payload: buildGatewayDeliveryPayload({
      runId: params.runId,
      channel: params.channel,
      result: params.result,
    }),
    channel: params.channel,
  });
}

function createGatewayInflightUnavailableFailure(params: {
  context: GatewayRequestContext;
  dedupeKey: string;
  channel: string;
  err: unknown;
}): InflightResult {
  const authorizationDenied =
    params.err instanceof ToolAuthorizationError ||
    findMessageActionPolicyDenial(params.err) !== null;
  const error = errorShape(
    authorizationDenied ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    authorizationDenied ? "Message action blocked by authorization policy." : String(params.err),
  );
  cacheGatewayDedupeFailure({
    context: params.context,
    dedupeKey: params.dedupeKey,
    error,
  });
  return {
    ok: false,
    error,
    meta: { channel: params.channel, error: formatForLog(params.err) },
  };
}

async function mirrorDeliveredSourceReplyToTranscriptBestEffort(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}) {
  try {
    const mirrored = await mirrorDeliveredSourceReplyToTranscript(params.mirror);
    if (!mirrored && params.mirror.sourceReplyFinal === true) {
      params.context.logGateway?.warn?.(
        "Terminal source reply receipt was not mirrored; restart recovery is fail-closed.",
        {
          channel: params.mirror.channel,
          sessionKey: params.mirror.sessionKey,
        },
      );
    }
  } catch (err) {
    params.context.logGateway?.warn?.("Source reply transcript mirror failed after delivery.", {
      error: formatForLog(err),
      channel: params.mirror.channel,
      sessionKey: params.mirror.sessionKey,
    });
  }
}

const sourceReplyTranscriptMirrorQueue = new KeyedAsyncQueue();

function resolveSourceReplyTranscriptMirrorQueueKey(
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0],
): string {
  // Missing session keys are serialized together so global mirrors preserve delivery order.
  return mirror.sessionKey?.trim() || "__global__";
}

function scheduleDeliveredSourceReplyTranscriptMirror(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof mirrorDeliveredSourceReplyToTranscript>[0];
}): Promise<void> {
  const queueKey = resolveSourceReplyTranscriptMirrorQueueKey(params.mirror);
  // Queue per session so current-conversation source replies are visible before
  // a following turn can read the transcript.
  return sourceReplyTranscriptMirrorQueue.enqueue(queueKey, () =>
    mirrorDeliveredSourceReplyToTranscriptBestEffort(params),
  );
}

export const sendHandlers: GatewayRequestHandlers = {
  "message.action": async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateMessageActionParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid message.action params: ${formatValidationErrors(validateMessageActionParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      channel: string;
      action: string;
      params: Record<string, unknown>;
      accountId?: string;
      requesterAccountId?: string;
      requesterSenderId?: string;
      senderIsOwner?: boolean;
      sessionKey?: string;
      sessionId?: string;
      inboundTurnKind?: "user_request" | "room_event";
      agentId?: string;
      toolContext?: MessageActionToolContext;
      conversationReadOrigin?: "direct-operator";
      idempotencyKey: string;
    };
    const trustedContext = resolveTrustedAgentRuntimeMessageContext({ client });
    if (!trustedContext.ok) {
      respond(false, undefined, trustedContext.error);
      return;
    }
    const identityError = validateTrustedAgentRuntimeRequestIdentity({
      trustedContext,
      request,
      requireSessionKey: true,
    });
    if (identityError) {
      respond(false, undefined, identityError);
      return;
    }
    const conversationReadOrigin = resolveGatewayConversationReadOrigin({
      client,
      requestedOrigin: request.conversationReadOrigin,
    });
    const inflight = resolveGatewayInflightRequest({
      context,
      prefix: "message.action",
      idempotencyKey: request.idempotencyKey,
      respond,
      conversationReadOrigin,
    });
    if (inflight.kind === "handled") {
      await inflight.done;
      return;
    }
    const { dedupeKey, inflightMap } = inflight;
    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported channel: ${input}`,
        context,
        rejectWebchatAsInternalOnly: true,
      });
      if ("error" in resolvedChannel) {
        return { ok: false, error: resolvedChannel.error };
      }
      const { cfg: selectedCfg, sourceCfg, channel } = resolvedChannel;
      const cfg = resolveMessageActionRuntimeConfig({ cfg: selectedCfg, sourceCfg });
      if (request.action === "broadcast") {
        // Connected operators already passed the central `operator.write` method
        // gate. This local check only rejects callers with neither authority path.
        if (!trustedContext.identityAgentId && !client?.connect) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              "Gateway broadcast delegation requires an authenticated runtime or operator.",
            ),
          };
        }
        try {
          const sessionKey = normalizeOptionalString(request.sessionKey) ?? undefined;
          const agentId =
            normalizeOptionalString(request.agentId) ??
            trustedContext.identityAgentId ??
            (sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
          const accountId = normalizeOptionalString(request.accountId) ?? undefined;
          const authorization = resolveGatewayMessageActionAuthorizationContext({
            client,
            agentId,
            sessionKey,
            sessionId: request.sessionId,
            trustedContext,
          });
          const delegatedChannel =
            normalizeOptionalLowercaseString(request.params.channel) === "all" ? "all" : channel;
          const broadcast = await runMessageAction({
            cfg,
            action: "broadcast",
            params: {
              ...request.params,
              channel: delegatedChannel,
              idempotencyKey: request.idempotencyKey,
            },
            defaultAccountId: accountId,
            requesterAccountId: trustedContext.requesterAccountId,
            requesterSenderId: trustedContext.requesterSenderId,
            senderIsOwner:
              authorization.principal.kind === "sender"
                ? authorization.principal.senderIsOwner
                : authorization.principal.kind === "operator"
                  ? authorization.principal.isOwner
                  : false,
            messageActionAuthorization: {
              requesterAccountId: trustedContext.requesterAccountId,
              requesterSenderId: trustedContext.requesterSenderId,
              requesterSenderIsOwner: trustedContext.requesterSenderIsOwner,
              requesterIsAuthorizedSender: trustedContext.requesterIsAuthorizedSender,
              requesterRoleIds: trustedContext.requesterRoleIds,
              toolContext: trustedContext.toolContext,
            },
            authorization,
            sessionKey,
            sessionId: trustedContext.identityAgentId
              ? trustedContext.sessionId
              : normalizeOptionalString(request.sessionId),
            toolContext: trustedContext.toolContext,
            conversationReadOrigin,
            inboundEventKind: request.inboundTurnKind,
            agentId,
            gatewayOwnedDelivery: true,
            deps: context.deps ? createOutboundSendDeps(context.deps) : undefined,
          });
          if (broadcast.kind !== "broadcast") {
            throw new Error("Gateway broadcast delegation returned an unexpected result.");
          }
          return createGatewayInflightSuccess({
            context,
            dedupeKey,
            payload: broadcast.payload,
            channel,
          });
        } catch (err) {
          return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
        }
      }
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      if (!plugin?.actions?.handleAction) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Channel ${channel} does not support action ${request.action}.`,
          ),
        };
      }

      try {
        const sessionKey = normalizeOptionalString(request.sessionKey) ?? undefined;
        const agentId =
          normalizeOptionalString(request.agentId) ??
          (sessionKey ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
        const accountId = normalizeOptionalString(request.accountId) ?? undefined;
        if (request.action === "send") {
          await hydrateAttachmentParamsForAction({
            cfg,
            channel,
            accountId,
            args: request.params,
            action: "send",
            mediaPolicy: resolveAttachmentMediaPolicy({
              mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
            }),
          });
        }
        const target =
          normalizeOptionalString(request.params.to) ??
          normalizeOptionalString(request.params.channelId);
        const threadId =
          normalizeOptionalString(request.params.threadId) ??
          normalizeOptionalString(request.params.threadTs);
        await authorizePreparedMessageAction({
          cfg,
          action: request.action as ChannelMessageActionName,
          channel,
          accountId,
          target,
          threadId,
          dryRun: false,
          input: {
            ...request.params,
            channel,
            ...(accountId ? { accountId } : {}),
            ...(target ? { target, to: target } : {}),
            ...(threadId ? { threadId } : {}),
            dryRun: false,
          },
          authorization: resolveGatewayMessageActionAuthorizationContext({
            client,
            agentId,
            sessionKey,
            sessionId: request.sessionId,
            targetConversationId: target,
            threadId,
            trustedContext,
          }),
        });
        const sourceReplyMirror = {
          action: request.action,
          channel,
          actionParams: request.params,
          cfg,
          accountId,
          currentAccountId: trustedContext.requesterAccountId,
          sessionKey,
          sessionId: trustedContext.sessionId,
          agentId,
          toolContext: trustedContext.toolContext,
          idempotencyKey: request.idempotencyKey,
          toolCallId: trustedContext.sourceReplyToolCallId,
          ...(trustedContext.sourceReplyFinal !== undefined
            ? { sourceReplyFinal: trustedContext.sourceReplyFinal }
            : {}),
        };
        const terminalDeliveryReceipt =
          trustedContext.sourceReplyFinal === true
            ? await beginTerminalSourceReplyDelivery(sourceReplyMirror)
            : undefined;
        const gatewayClientScopes = client?.connect?.scopes ?? [];
        const handled = await dispatchChannelMessageAction({
          channel,
          action: request.action as never,
          cfg,
          params: request.params,
          accountId,
          requesterAccountId: trustedContext.requesterAccountId,
          requesterSenderId: trustedContext.requesterSenderId,
          senderIsOwner: trustedContext.requesterSenderId
            ? trustedContext.requesterSenderIsOwner === true
            : gatewayClientScopes.includes(ADMIN_SCOPE)
              ? request.senderIsOwner === true
              : false,
          conversationReadOrigin,
          sessionKey,
          sessionId: trustedContext.identityAgentId
            ? trustedContext.sessionId
            : normalizeOptionalString(request.sessionId),
          inboundEventKind: request.inboundTurnKind,
          agentId,
          mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, agentId),
          toolContext: trustedContext.toolContext,
          dryRun: false,
          gatewayClientScopes,
        });
        if (!handled) {
          await cancelTerminalSourceReplyDelivery(terminalDeliveryReceipt);
          const error = errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Message action ${request.action} not supported for channel ${channel}.`,
          );
          cacheGatewayDedupeFailure({ context, dedupeKey, error });
          return { ok: false, error, meta: { channel } };
        }
        const payload = extractToolPayload(handled);
        try {
          await reconcileTerminalSourceReplyDelivery({
            deliveredPayload: payload,
            mirror: sourceReplyMirror,
            receipt: terminalDeliveryReceipt,
          });
        } catch (err) {
          // The pre-send intent remains durable. Return the provider result so
          // the model does not retry an external effect with an unknown outcome.
          context.logGateway?.warn?.("Terminal source reply receipt reconciliation failed.", {
            error: formatForLog(err),
            channel,
            sessionKey,
          });
        }
        await scheduleDeliveredSourceReplyTranscriptMirror({
          context,
          mirror: {
            ...sourceReplyMirror,
            deliveredPayload: payload,
          },
        });
        return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
      } catch (err) {
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
  send: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      message?: string;
      mediaUrl?: string;
      mediaUrls?: string[];
      buffer?: string;
      filename?: string;
      contentType?: string;
      asVoice?: boolean;
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      agentId?: string;
      replyToId?: string;
      threadId?: string;
      forceDocument?: boolean;
      silent?: boolean;
      parseMode?: "HTML";
      sessionKey?: string;
      idempotencyKey: string;
    };
    const trustedContext = resolveTrustedAgentRuntimeMessageContext({ client });
    if (!trustedContext.ok) {
      respond(false, undefined, trustedContext.error);
      return;
    }
    const identityError = validateTrustedAgentRuntimeRequestIdentity({
      trustedContext,
      request,
      requireSessionKey: false,
    });
    if (identityError) {
      respond(false, undefined, identityError);
      return;
    }
    const inflight = resolveGatewayInflightRequest({
      context,
      prefix: "send",
      idempotencyKey: request.idempotencyKey,
      respond,
    });
    if (inflight.kind === "handled") {
      await inflight.done;
      return;
    }
    const { idem, dedupeKey, inflightMap } = inflight;
    const to = normalizeOptionalString(request.to) ?? "";
    const message = normalizeOptionalString(request.message) ?? "";
    const mediaUrl = normalizeOptionalString(request.mediaUrl);
    const mediaUrls = Array.isArray(request.mediaUrls)
      ? request.mediaUrls
          .map((entry) => normalizeOptionalString(entry))
          .filter((entry): entry is string => Boolean(entry))
      : undefined;
    const buffer = readStringValue(request.buffer);
    if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0 && !buffer) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
      );
      return;
    }
    const accountId = normalizeOptionalString(request.accountId);
    const replyToId = normalizeOptionalString(request.replyToId);
    const threadId = normalizeOptionalString(request.threadId);

    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveInternalDeliveryChannel(request.channel, context);
      if (resolvedChannel.kind !== "ready") {
        return resolvedChannel.result;
      }
      const { cfg, channel } = resolvedChannel;
      const outboundChannel = channel;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      if (!plugin) {
        return {
          ok: false,
          error: errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
        };
      }

      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel: outboundChannel,
          to,
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return {
            ok: false,
            error: resolvedTarget.error,
            meta: { channel },
          };
        }
        const idLikeTarget = await maybeResolveIdLikeTarget({
          cfg,
          channel,
          input: resolvedTarget.to,
          accountId,
        });
        const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
        // Preserve opaque, case-sensitive peer IDs (e.g. Matrix room ids) on an
        // explicit session key instead of raw-lowercasing it (openclaw#75670).
        // Non-enrolled channels still canonicalize to lowercase via the registry.
        const providedSessionKey =
          trustedContext.identitySessionKey ??
          (normalizeSessionKeyPreservingOpaquePeerIds(request.sessionKey) || undefined);
        const explicitAgentId =
          trustedContext.identityAgentId ?? normalizeOptionalString(request.agentId);
        const sessionAgentId = providedSessionKey
          ? resolveSessionAgentId({ sessionKey: providedSessionKey, config: cfg })
          : undefined;
        const defaultAgentId = resolveSessionAgentId({ config: cfg });
        const effectiveAgentId = explicitAgentId ?? sessionAgentId ?? defaultAgentId;
        const sendArgs: Record<string, unknown> = {
          mediaUrl,
          mediaUrls,
          buffer,
          filename: normalizeOptionalString(request.filename) ?? undefined,
          contentType: normalizeOptionalString(request.contentType) ?? undefined,
        };
        await hydrateAttachmentParamsForAction({
          cfg,
          channel,
          accountId,
          args: sendArgs,
          action: "send",
          mediaPolicy: resolveAttachmentMediaPolicy({
            mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, effectiveAgentId),
          }),
        });
        const hydratedMediaUrl = normalizeOptionalString(sendArgs.mediaUrl);
        const hydratedMediaUrls = Array.isArray(sendArgs.mediaUrls)
          ? sendArgs.mediaUrls
              .map((entry) => normalizeOptionalString(entry))
              .filter((entry): entry is string => Boolean(entry))
          : undefined;
        const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
        const outboundPayloads = [
          {
            text: message,
            mediaUrl: hydratedMediaUrl,
            mediaUrls: hydratedMediaUrls,
            ...(request.asVoice === true ? { audioAsVoice: true } : {}),
          },
        ];
        const outboundPayloadPlan = createOutboundPayloadPlan(outboundPayloads);
        const mirrorProjection = projectOutboundPayloadPlanForMirror(outboundPayloadPlan);
        const mirrorText = mirrorProjection.text;
        const mirrorMediaUrls = mirrorProjection.mediaUrls;
        const derivedRoute = await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId: effectiveAgentId,
          accountId,
          target: deliveryTarget,
          currentSessionKey: providedSessionKey,
          resolvedTarget: idLikeTarget,
          replyToId,
          threadId,
        });
        const providedSessionBaseKey =
          parseThreadSessionSuffix(providedSessionKey).baseSessionKey ?? providedSessionKey;
        const shouldUseDerivedThreadSessionKey =
          channel === "slack" &&
          Boolean(providedSessionKey) &&
          Boolean(normalizeOptionalString(derivedRoute?.threadId)) &&
          normalizeOptionalLowercaseString(derivedRoute?.baseSessionKey) ===
            normalizeOptionalLowercaseString(providedSessionBaseKey) &&
          normalizeOptionalLowercaseString(derivedRoute?.sessionKey) !== providedSessionKey;
        // Slack replies can refine an existing base session into a thread session after target lookup.
        const outboundRoute = derivedRoute
          ? providedSessionKey
            ? shouldUseDerivedThreadSessionKey
              ? {
                  ...derivedRoute,
                  baseSessionKey: derivedRoute.baseSessionKey ?? providedSessionKey,
                }
              : {
                  ...derivedRoute,
                  sessionKey: providedSessionKey,
                  baseSessionKey: providedSessionKey,
                }
            : derivedRoute
          : null;
        const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
        if (outboundSessionKey && isAgentHarnessSessionKey(outboundSessionKey)) {
          const { canonicalKey, entry } = loadSessionEntry(outboundSessionKey);
          const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
            canonicalKey,
            entry,
          );
          if (missingHarnessSessionError) {
            return {
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError),
              meta: { channel },
            };
          }
        }
        const resolvedThreadId = outboundRoute?.threadId ?? threadId;
        const authorization = resolveGatewayMessageActionAuthorizationContext({
          client,
          agentId: effectiveAgentId,
          sessionKey: outboundSessionKey,
          targetConversationId: deliveryTarget,
          threadId: resolvedThreadId,
          trustedContext,
        });
        const authorizePayload = async (payload: ReplyPayload): Promise<boolean> => {
          return await authorizePreparedMessageAction({
            cfg,
            action: "send",
            channel: outboundChannel,
            accountId,
            target: deliveryTarget,
            threadId: resolvedThreadId,
            dryRun: false,
            input: buildCanonicalSendMessageActionInput({
              input: request,
              payload,
              message: payload.text,
              mediaUrl: payload.mediaUrl,
              mediaUrls: payload.mediaUrls,
              audioAsVoice: payload.audioAsVoice,
              fallbackReplyToId: replyToId,
              extra: {
                channel: outboundChannel,
                target: deliveryTarget,
                to: deliveryTarget,
                ...(accountId ? { accountId } : {}),
                ...(resolvedThreadId !== undefined ? { threadId: resolvedThreadId } : {}),
                dryRun: false,
              },
            }),
            authorization,
          });
        };
        const authorizedPayload = outboundPayloads[0]!;
        const enforceFinalPayloadAuthorization = await authorizePayload(authorizedPayload);
        if (outboundRoute) {
          await ensureOutboundSessionEntry({
            cfg,
            channel,
            accountId,
            route: outboundRoute,
          });
        }
        const outboundSession = buildOutboundSessionContext({
          cfg,
          agentId: effectiveAgentId,
          sessionKey: outboundSessionKey,
          conversationType: outboundRoute?.chatType,
        });
        const send = await sendDurableMessageBatch({
          cfg,
          channel: outboundChannel,
          to: deliveryTarget,
          accountId,
          payloads: outboundPayloads,
          replyToId: replyToId ?? null,
          session: outboundSession,
          gifPlayback: request.gifPlayback,
          forceDocument: request.forceDocument,
          threadId: outboundRoute?.threadId ?? threadId ?? null,
          deps: outboundDeps,
          gatewayClientScopes: client?.connect?.scopes ?? [],
          silent: request.silent,
          formatting: request.parseMode ? { parseMode: request.parseMode } : undefined,
          effectAuthorizationScope: "message-action",
          ...(enforceFinalPayloadAuthorization
            ? {
                effectAuthorization: {
                  authorizedPayload,
                  enforceFinalPayloadAuthorization: true,
                  authorizeChangedPayload: async (payload: ReplyPayload) => {
                    await authorizePayload(payload);
                  },
                },
              }
            : {}),
          mirror: outboundSessionKey
            ? {
                sessionKey: outboundSessionKey,
                agentId: effectiveAgentId,
                text: mirrorText || message,
                mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
                idempotencyKey: idem,
              }
            : undefined,
        });
        if (send.status === "failed" || send.status === "partial_failed") {
          throw send.error;
        }
        const results = send.status === "sent" ? send.results : [];

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        return createGatewayDeliveryInflightSuccess({
          context,
          dedupeKey,
          runId: idem,
          channel,
          result,
        });
      } catch (err) {
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
  poll: async ({ params, respond, context, client }) => {
    const p = params;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationSeconds?: number;
      durationHours?: number;
      silent?: boolean;
      isAnonymous?: boolean;
      threadId?: string;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const trustedContext = resolveTrustedAgentRuntimeMessageContext({ client });
    if (!trustedContext.ok) {
      respond(false, undefined, trustedContext.error);
      return;
    }
    const inflight = resolveGatewayInflightRequest({
      context,
      prefix: "poll",
      idempotencyKey: request.idempotencyKey,
      respond,
    });
    if (inflight.kind === "handled") {
      await inflight.done;
      return;
    }
    const { idem, dedupeKey, inflightMap } = inflight;
    const work = (async (): Promise<InflightResult> => {
      const resolvedChannel = await resolveRequestedChannel({
        requestChannel: request.channel,
        unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
        context,
      });
      if ("error" in resolvedChannel) {
        return { ok: false, error: resolvedChannel.error };
      }
      const { cfg, channel } = resolvedChannel;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const outbound = plugin?.outbound;
      if (
        typeof request.durationSeconds === "number" &&
        outbound?.supportsPollDurationSeconds !== true
      ) {
        // Duration support is channel-specific; reject before normalizing to avoid silent truncation.
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `durationSeconds is not supported for ${channel} polls`,
          ),
        };
      }
      if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `isAnonymous is not supported for ${channel} polls`,
          ),
        };
      }
      const poll = {
        question: request.question,
        options: request.options,
        maxSelections: request.maxSelections,
        durationSeconds: request.durationSeconds,
        durationHours: request.durationHours,
      };
      const threadId = normalizeOptionalString(request.threadId);
      const accountId = normalizeOptionalString(request.accountId);
      try {
        if (!outbound?.sendPoll) {
          const error = errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported poll channel: ${channel}`,
          );
          return { ok: false, error };
        }
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel,
          to: request.to.trim(),
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return { ok: false, error: resolvedTarget.error };
        }
        const normalized = outbound.pollMaxOptions
          ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
          : normalizePollInput(poll);
        await authorizePreparedMessageAction({
          cfg,
          action: "poll",
          channel,
          accountId,
          target: resolvedTarget.to,
          threadId,
          dryRun: false,
          input: {
            ...request,
            channel,
            to: resolvedTarget.to,
            poll: normalized,
            ...(accountId ? { accountId } : {}),
            ...(threadId ? { threadId } : {}),
          },
          authorization: resolveGatewayMessageActionAuthorizationContext({
            client,
            targetConversationId: resolvedTarget.to,
            threadId,
            trustedContext,
          }),
        });
        const result = await outbound.sendPoll({
          cfg,
          to: resolvedTarget.to,
          poll: normalized,
          accountId,
          threadId,
          silent: request.silent,
          isAnonymous: request.isAnonymous,
          gatewayClientScopes: client?.connect?.scopes ?? [],
        });
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        cacheGatewayDedupeSuccess({
          context,
          dedupeKey,
          payload,
        });
        return { ok: true, payload, meta: { channel } };
      } catch (err) {
        return createGatewayInflightUnavailableFailure({
          context,
          dedupeKey,
          channel,
          err,
        });
      }
    })();

    await runGatewayInflightWork({ inflightMap, dedupeKey, work, respond });
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
