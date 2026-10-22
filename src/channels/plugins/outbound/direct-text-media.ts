import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { chunkText } from "../../../auto-reply/chunk.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { sanitizeForPlainText } from "../../../infra/outbound/sanitize-text.js";
import type { OutboundMediaAccess } from "../../../media/load-options.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter, ChannelOutboundContext } from "../outbound.types.js";

type DirectSendOptions = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  replyToId?: string | null;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
};

type DirectSendResult = { messageId: string; [key: string]: unknown };

type DirectSendFn<TOpts extends Record<string, unknown>, TResult extends DirectSendResult> = (
  to: string,
  text: string,
  opts: TOpts,
) => Promise<TResult>;

function readNumberField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

export function createScopedChannelMediaMaxBytesResolver(channel: string) {
  return (params: { cfg: OpenClawConfig; accountId?: string | null }) =>
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      accountId: params.accountId,
      resolveChannelLimitMb: ({ cfg, accountId }) => {
        const channelConfig = asRecord(cfg.channels?.[channel]);
        const accountConfig = asRecord(asRecord(channelConfig?.accounts)?.[accountId]);
        return (
          readNumberField(accountConfig, "mediaMaxMb") ??
          readNumberField(channelConfig, "mediaMaxMb")
        );
      },
    });
}

export function createDirectTextMediaOutbound<
  TOpts extends Record<string, unknown>,
  TResult extends DirectSendResult,
>(params: {
  channel: string;
  resolveSender: (deps: OutboundSendDeps | undefined) => DirectSendFn<TOpts, TResult>;
  resolveMaxBytes: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => number | undefined;
  buildTextOptions: (params: DirectSendOptions) => TOpts;
  buildMediaOptions: (params: DirectSendOptions) => TOpts;
}): ChannelOutboundAdapter {
  const sendDirect = async (
    { cfg, to, text, accountId, deps, replyToId }: ChannelOutboundContext,
    buildOptions: (params: DirectSendOptions) => TOpts,
    media?: { mediaUrl?: string; mediaAccess?: OutboundMediaAccess },
  ) => {
    const send = params.resolveSender(deps);
    const maxBytes = params.resolveMaxBytes({ cfg, accountId });
    const result = await send(
      to,
      text,
      buildOptions({
        cfg,
        mediaUrl: media?.mediaUrl,
        mediaAccess: media?.mediaAccess,
        mediaLocalRoots: media?.mediaAccess?.localRoots,
        mediaReadFile: media?.mediaAccess?.readFile,
        accountId,
        replyToId,
        maxBytes,
      }),
    );
    return { channel: params.channel, ...result };
  };

  const outbound: ChannelOutboundAdapter = {
    deliveryMode: "direct",
    chunker: chunkText,
    chunkerMode: "text",
    textChunkLimit: 4000,
    sanitizeText: ({ text }) => sanitizeForPlainText(text),
    sendPayload: async (ctx) => {
      const { sendTextMediaPayload } = await import("openclaw/plugin-sdk/reply-payload");
      return await sendTextMediaPayload({ channel: params.channel, ctx, adapter: outbound });
    },
    sendText: (ctx) => sendDirect(ctx, params.buildTextOptions),
    sendMedia: (ctx) => {
      const { mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile } = ctx;
      return sendDirect(ctx, params.buildMediaOptions, {
        mediaUrl,
        // Older callers pass local media access as split roots/readFile fields;
        // normalize them into the newer mediaAccess object before option building.
        mediaAccess:
          mediaAccess ??
          (mediaLocalRoots || mediaReadFile
            ? {
                ...(mediaLocalRoots?.length ? { localRoots: mediaLocalRoots } : {}),
                ...(mediaReadFile ? { readFile: mediaReadFile } : {}),
              }
            : undefined),
      });
    },
  };
  return outbound;
}
