import { chunkText } from "../../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.js";

type DirectSendOptions = {
  accountId?: string | null;
  replyToId?: string | null;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
};

type DirectSendResult = { messageId: string; [key: string]: unknown };

type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (
  to: string,
  text: string,
  opts: TOpts,
) => Promise<TResult>;

export function resolveScopedChannelMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  resolveChannelLimitMb: (params: { cfg: OpenClawConfig; accountId: string }) => number | undefined;
}): number | undefined {
  return resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: params.resolveChannelLimitMb,
    accountId: params.accountId,
  });
}

export function createScopedChannelMediaMaxBytesResolver(channel: "imessage" | "signal") {
  return (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveScopedChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.[channel]?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.[channel]?.mediaMaxMb,
    });
}

export function createDirectTextMediaOutbound<
  TOpts extends Record<string, unknown>,
  TResult extends DirectSendResult,
>(params: {
  channel: "imessage" | "signal";
  resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
  resolveMaxBytes: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => number | undefined;
  buildTextOptions: (params: DirectSendOptions) => TOpts;
  buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter {
  const sendDirect = async (sendParams: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    deps?: OutboundSendDeps;
    replyToId?: string | null;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    buildOptions: (params: DirectSendOptions) => TOpts;
  }) => {
    const send = params.resolveSender(sendParams.deps);
    const maxBytes = params.resolveMaxBytes({
      cfg: sendParams.cfg,
      accountId: sendParams.accountId,
    });
    const result = await send(
      sendParams.to,
      sendParams.text,
      sendParams.buildOptions({
        mediaUrl: sendParams.mediaUrl,
        mediaLocalRoots: sendParams.mediaLocalRoots,
        accountId: sendParams.accountId,
        replyToId: sendParams.replyToId,
        maxBytes,
      }),
    );
    return { channel: params.channel, ...result };
  };

  return {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendFinal: async (ctx) => {
      const media =
        ctx.payload.mediaUrl ??
        (Array.isArray(ctx.payload.mediaUrls) && ctx.payload.mediaUrls.length > 0
          ? ctx.payload.mediaUrls[0]
          : undefined);
      if (media) {
        return await sendDirect({
          cfg: ctx.cfg,
          to: ctx.to,
          text: ctx.payload.text ?? ctx.text,
          mediaUrl: media,
          mediaLocalRoots: ctx.mediaLocalRoots,
          accountId: ctx.accountId,
          deps: ctx.deps,
          replyToId: ctx.payload.replyToId ?? ctx.replyToId,
          buildOptions: params.buildMediaOptions,
        });
      }
      return await sendDirect({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.payload.text ?? ctx.text,
        accountId: ctx.accountId,
        deps: ctx.deps,
        replyToId: ctx.payload.replyToId ?? ctx.replyToId,
        buildOptions: params.buildTextOptions,
      });
    },
    sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
      return await sendDirect({
        cfg,
        to,
        text,
        accountId,
        deps,
        replyToId,
        buildOptions: params.buildTextOptions,
      });
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId }) => {
      return await sendDirect({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        replyToId,
        buildOptions: params.buildMediaOptions,
      });
    },
  };
}
