/**
 * Direct-DM dispatch compatibility facade.
 *
 * Routes legacy direct-message ingress through the standard channel reply pipeline.
 */
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOutboundReplyPayload,
  type OutboundReplyPayload,
} from "../plugin-sdk/reply-payload.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { buildChannelInboundEventContext } from "./inbound-event/context.js";
import { resolveChannelInboundRouteEnvelope } from "./inbound-event/envelope.js";
import { createChannelReplyPipeline } from "./message/reply-pipeline.js";
import { dispatchChannelInboundTurn, runPreparedInboundReply } from "./turn/kernel.js";
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

type DispatchInboundDirectDmParams = {
  cfg: OpenClawConfig;
  channel: string;
  channelLabel: string;
  accountId: string;
  peer: DirectDmRoutePeer;
  senderId: string;
  senderAddress: string;
  recipientAddress: string;
  conversationLabel: string;
  rawBody: string;
  messageId: string;
  timestamp?: number;
  commandAuthorized?: boolean;
  /** Set only after the channel's sender/pairing guard admits this event. */
  inboundAccessAuthorized?: boolean;
  bodyForAgent?: string;
  commandBody?: string;
  provider?: string;
  surface?: string;
  originatingChannel?: string;
  originatingTo?: string;
  extraContext?: Record<string, unknown>;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
};

function buildDirectDmContext(
  params: DispatchInboundDirectDmParams,
  route: DirectDmRoute,
  body: string,
): FinalizedMsgContext {
  const accountId = route.accountId ?? params.accountId;
  return buildChannelInboundEventContext({
    channel: params.channel,
    accountId,
    provider: params.provider,
    surface: params.surface,
    messageId: params.messageId,
    messageIdFull: params.messageId,
    timestamp: params.timestamp,
    from: params.senderAddress,
    sender: { id: params.senderId, name: params.conversationLabel },
    conversation: { kind: "direct", id: params.peer.id, label: params.conversationLabel },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: {
      to: params.recipientAddress,
      originatingTo: params.originatingTo ?? params.recipientAddress,
    },
    message: {
      body,
      bodyForAgent: params.bodyForAgent ?? params.rawBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
    },
    access: { commands: { authorized: params.commandAuthorized === true } },
    extra: {
      OriginatingChannel: params.originatingChannel ?? params.channel,
      ...params.extraContext,
    },
  });
}

function prepareDirectDmTurn(params: DispatchInboundDirectDmParams) {
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  const body = buildEnvelope({
    channel: params.channelLabel,
    from: params.conversationLabel,
    body: params.rawBody,
    timestamp: params.timestamp,
  });
  return { route, ctxPayload: buildDirectDmContext(params, route, body) };
}

export async function dispatchInboundDirectDm(params: DispatchInboundDirectDmParams): Promise<{
  route: DirectDmRoute;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, ctxPayload } = prepareDirectDmTurn(params);
  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: route.agentId,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
  });

  await dispatchChannelInboundTurn({
    cfg: params.cfg,
    channel: params.channel,
    accountId: route.accountId ?? params.accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    record: {
      onRecordError: params.onRecordError,
    },
    delivery: {
      deliver: async (payload) => await params.deliver(normalizeOutboundReplyPayload(payload)),
      onError: params.onDispatchError,
    },
    replyPipeline,
    replyOptions: { onModelSelected },
  });

  return { route, ctxPayload };
}

export async function dispatchInboundDirectDmWithRuntime(
  params: DispatchInboundDirectDmParams & { runtime: PluginRuntime },
): Promise<{
  route: DirectDmRoute;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
}> {
  const { route, ctxPayload } = prepareDirectDmTurn(params);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: route.agentId });
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
    record: { onRecordError: params.onRecordError },
    runDispatch: async () =>
      await params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: unknown) => {
            const normalized =
              payload && typeof payload === "object"
                ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
                : {};
            return await params.deliver(normalized);
          },
          onError: params.onDispatchError,
        },
        replyOptions: { onModelSelected },
      }),
  });
  return { route, storePath, ctxPayload };
}
