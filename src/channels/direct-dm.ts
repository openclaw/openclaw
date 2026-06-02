import type { DispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.types.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "../plugin-sdk/inbound-envelope.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../plugin-sdk/reply-payload.js";
import { createChannelReplyPipeline } from "./message/reply-pipeline.js";
import { runPreparedInboundReply } from "./turn/kernel.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "./direct-dm-access.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm-guard-policy.js";

type DirectDmRoutePeer = {
  kind: "direct";
  id: string;
};

type DirectDmRoute = {
  agentId: string;
  sessionKey: string;
  accountId?: string;
};

type DirectDmRuntime = {
  channel: {
    routing: {
      resolveAgentRoute: (params: {
        cfg: OpenClawConfig;
        channel: string;
        accountId: string;
        peer: DirectDmRoutePeer;
      }) => DirectDmRoute;
    };
    session: {
      resolveStorePath: typeof import("../config/sessions.js").resolveStorePath;
      readSessionUpdatedAt: (params: {
        storePath: string;
        sessionKey: string;
      }) => number | undefined;
      recordInboundSession: typeof import("../channels/session.js").recordInboundSession;
    };
    reply: {
      resolveEnvelopeFormatOptions: (
        cfg: OpenClawConfig,
      ) => ReturnType<typeof import("../auto-reply/envelope.js").resolveEnvelopeFormatOptions>;
      formatAgentEnvelope: typeof import("../auto-reply/envelope.js").formatAgentEnvelope;
      finalizeInboundContext: typeof import("../auto-reply/reply/inbound-context.js").finalizeInboundContext;
      dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcher;
    };
  };
};

/** Route, envelope, record, and dispatch one direct-DM turn through the standard pipeline. */
export async function dispatchInboundDirectDmWithRuntime(params: {
  /** Runtime config used for route resolution, session storage, and reply dispatch. */
  cfg: OpenClawConfig;
  /** Channel-owned routing/session/reply callbacks injected by the adapter. */
  runtime: DirectDmRuntime;
  /** Stable channel id used for routing, session records, and plugin policy. */
  channel: string;
  /** Human-readable channel label used when formatting the inbound envelope. */
  channelLabel: string;
  /** Account scope for route/session/plugin policy decisions. */
  accountId: string;
  /** Direct peer identity passed into the channel route resolver. */
  peer: DirectDmRoutePeer;
  /** Raw sender id used in context and access decisions. */
  senderId: string;
  /** Provider-specific sender address exposed to the agent context. */
  senderAddress: string;
  /** Provider-specific recipient address exposed to the agent context. */
  recipientAddress: string;
  /** Display label for the direct conversation. */
  conversationLabel: string;
  /** Original provider body before command/body normalization. */
  rawBody: string;
  /** Provider message id used as both short and full message identifiers. */
  messageId: string;
  /** Provider timestamp, if available, preserved in the finalized context. */
  timestamp?: number;
  /** Command authorization result already computed by pre-dispatch access checks. */
  commandAuthorized?: boolean;
  /** Agent-visible body when command parsing strips or rewrites the raw body. */
  bodyForAgent?: string;
  /** Command parser body when it differs from the raw provider body. */
  commandBody?: string;
  /** Provider label override for context surfaces that distinguish provider from channel. */
  provider?: string;
  /** Surface label override for channel variants sharing one provider. */
  surface?: string;
  /** Origin channel override for forwarded or bridged DMs. */
  originatingChannel?: string;
  /** Origin recipient override for forwarded or bridged DMs. */
  originatingTo?: string;
  /** Adapter-specific context fields merged after the standard DM fields. */
  extraContext?: Record<string, unknown>;
  /** Adapter delivery callback for normalized outbound replies. */
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  /** Records non-fatal session write failures. */
  onRecordError: (err: unknown) => void;
  /** Records reply dispatch failures with the dispatcher error kind. */
  onDispatchError: (err: unknown, info: { kind: string }) => void;
}): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    runtime: params.runtime.channel,
    sessionStore: params.cfg.session?.store,
  });

  const { storePath, body } = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });

  const ctxPayload = params.runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: params.bodyForAgent ?? params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.commandBody ?? params.rawBody,
    From: params.senderAddress,
    To: params.recipientAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.accountId,
    ChatType: "direct",
    ConversationLabel: params.conversationLabel,
    SenderId: params.senderId,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.channel,
    MessageSid: params.messageId,
    MessageSidFull: params.messageId,
    Timestamp: params.timestamp,
    CommandAuthorized: params.commandAuthorized,
    OriginatingChannel: params.originatingChannel ?? params.channel,
    OriginatingTo: params.originatingTo ?? params.recipientAddress,
    ...params.extraContext,
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });
  await runPreparedInboundReply({
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: params.runtime.channel.session.recordInboundSession,
    record: {
      onRecordError: params.onRecordError,
    },
    runDispatch: async () =>
      await params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: unknown) => {
            // Dispatcher payloads can come from channel-specific adapters; normalize before
            // handing them back to the direct-DM adapter's delivery callback.
            const normalized =
              payload && typeof payload === "object"
                ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
                : {};
            return await params.deliver(normalized);
          },
          onError: params.onDispatchError,
        },
        replyOptions: {
          onModelSelected,
        },
      }),
  });

  return {
    route,
    storePath,
    ctxPayload,
  };
}
