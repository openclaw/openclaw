import { withReplyDispatcher } from "../auto-reply/dispatch.js";
import {
  dispatchReplyFromConfig,
  type DispatchFromConfigResult,
} from "../auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
import {
  createNormalizedOutboundDeliverer,
  resolveOutboundMediaUrls,
  type OutboundReplyPayload,
} from "./reply-payload.js";

type ReplyOptionsWithoutModelSelected = Omit<
  Omit<GetReplyOptions, "onToolResult" | "onBlockReply">,
  "onModelSelected"
>;
type RecordInboundSessionFn = typeof import("../channels/session.js").recordInboundSession;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;

type ReplyDispatchFromConfigOptions = Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;

/** Run `dispatchReplyFromConfig` with a dispatcher that always gets its settled callback. */
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

/** Assemble the common inbound reply dispatch dependencies for a resolved route. */
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

/** Resolve the shared dispatch base and immediately record + dispatch one inbound reply turn. */
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

/** Record the inbound session first, then dispatch the reply using normalized outbound delivery. */
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

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
  });

  const sessionKey = params.ctxPayload.SessionKey ?? params.routeSessionKey;
  const channelId = params.channel;
  const to =
    params.ctxPayload.OriginatingTo ?? params.ctxPayload.To ?? params.ctxPayload.From ?? "";
  const accountId = params.accountId;

  // Wrap the deliver callback to emit message:sent internal hooks after each
  // delivery attempt. Channel plugin reply paths bypass deliverOutboundPayloads
  // (which normally emits this hook), so without this wrapper the policy feedback
  // subsystem never sees agent_reply actions for same-channel replies.
  const rawDeliver = createNormalizedOutboundDeliverer(params.deliver);
  const emitSentHook = (payload: unknown, success: boolean, error?: string): void => {
    try {
      const p =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
      // Extract text content — check both `text` and `content` fields since
      // OutboundReplyPayload callers may use either.
      const content = (() => {
        if (!p) {
          return "";
        }
        if (typeof p.text === "string") {
          return p.text;
        }
        if (typeof p.content === "string") {
          return p.content;
        }
        return "";
      })();
      // Flag media-only payloads so the policy layer can distinguish "empty
      // content because media-only" from "empty content because error".
      const hasMedia = p ? resolveOutboundMediaUrls(p as OutboundReplyPayload).length > 0 : false;
      triggerInternalHook(
        createInternalHookEvent("message", "sent", sessionKey, {
          to,
          content,
          success,
          ...(error ? { error } : {}),
          ...(hasMedia ? { hasMedia } : {}),
          channelId,
          accountId,
          conversationId: to,
        }),
      ).catch(() => {});
    } catch {
      // Internal hooks are non-critical — never disrupt delivery
    }
  };
  // Note: `deliver` below intentionally shadows the outer `params.deliver` —
  // the wrapped version is what gets passed to dispatchReplyWithBufferedBlockDispatcher.
  const deliver = async (payload: unknown): Promise<void> => {
    try {
      await rawDeliver(payload);
      emitSentHook(payload, true);
    } catch (err: unknown) {
      emitSentHook(payload, false, String(err));
      throw err; // Re-throw so the dispatcher's onError handler still fires
    }
  };

  await params.dispatchReplyWithBufferedBlockDispatcher({
    ctx: params.ctxPayload,
    cfg: params.cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver,
      onError: params.onDispatchError,
    },
    replyOptions: {
      ...params.replyOptions,
      onModelSelected,
    },
  });
}
