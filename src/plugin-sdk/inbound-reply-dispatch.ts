import { withReplyDispatcher } from "../auto-reply/dispatch.js";
import {
  dispatchReplyFromConfig,
  type DispatchFromConfigResult,
} from "../auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import type { OpenClawConfig } from "../config/config.js";
import { createNormalizedOutboundDeliverer, type OutboundReplyPayload } from "./reply-payload.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onToolResult" | "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;

export async function dispatchReplyFromConfigWithSettledDispatcher(params: {
  cfg: OpenClawConfig;
  ctxPayload: FinalizedMsgContext;
  dispatcher: ReplyDispatcher;
  onSettled: () => void | Promise<void>;
  replyOptions?: ReplyDispatchFromConfigOptions;
}): Promise<DispatchFromConfigResult> {
  return await withReplyDispatcher({
    dispatcher: params.dispatcher,
    onSettled: params.onSettled,
    run: () =>
      dispatchReplyFromConfig({
        ctx: params.ctxPayload,
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        replyOptions: params.replyOptions,
      }),
  });
}

export function buildInboundReplyDispatchBase(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  route: {
    agentId: string;
    sessionKey: string;
  };
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  core: {
    channel: {
      session: {
        recordInboundSession: RecordInboundSessionFn;
      };
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcherFn;
      };
    };
  };
}) {
  return {
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    agentId: params.route.agentId,
    routeSessionKey: params.route.sessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      params.core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
  };
}

type BuildInboundReplyDispatchBaseParams = Parameters<typeof buildInboundReplyDispatchBase>[0];
type RecordInboundSessionAndDispatchReplyParams = Parameters<
  typeof recordInboundSessionAndDispatchReply
>[0];

export async function dispatchInboundReplyWithBase(
  params: BuildInboundReplyDispatchBaseParams &
    Pick<
      RecordInboundSessionAndDispatchReplyParams,
      "deliver" | "onRecordError" | "onDispatchError" | "replyOptions"
    >,
): Promise<void> {
  const dispatchBase = buildInboundReplyDispatchBase(params);
  await recordInboundSessionAndDispatchReply({
    ...dispatchBase,
    deliver: params.deliver,
    onRecordError: params.onRecordError,
    onDispatchError: params.onDispatchError,
    replyOptions: params.replyOptions,
  });
}

export async function recordInboundSessionAndDispatchReply(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  routeSessionKey: string;
  storePath: string;
  ctxPayload: FinalizedMsgContext;
  recordInboundSession: RecordInboundSessionFn;
  dispatchReplyWithBufferedBlockDispatcher: DispatchReplyWithBufferedBlockDispatcherFn;
  deliver: (payload: OutboundReplyPayload) => Promise<void>;
  onRecordError: (err: unknown) => void;
  onDispatchError: (err: unknown, info: { kind: string }) => void;
  replyOptions?: ReplyOptionsWithoutModelSelected;
}): Promise<void> {
  await params.recordInboundSession({
    storePath: params.storePath,
    sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
    ctx: params.ctxPayload,
    onRecordError: params.onRecordError,
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
  });
  const deliver = createNormalizedOutboundDeliverer(params.deliver);

  await params.dispatchReplyWithBufferedBlockDispatcher({
    ctx: params.ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      ...prefixOptions,
      deliver,
      onError: params.onDispatchError,
    },
    replyOptions: {
      ...params.replyOptions,
      onModelSelected,
    },
  });
}
