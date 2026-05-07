import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type RuntimeSendOpts = {
  cfg?: OpenClawConfig;
  mediaUrl?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  threadId?: string | number | null;
  messageThreadId?: string | number;
  threadTs?: string | number;
  replyToId?: string | number | null;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  gatewayClientScopes?: readonly string[];
  /**
   * Channel-native interactive components (e.g. Discord action rows with
   * buttons). Forwarded to the underlying outbound adapter so HITL approval
   * flows can attach action rows when sending plain text.
   */
  components?: unknown;
  embeds?: unknown;
  filename?: string;
};

function resolveRuntimeThreadId(opts: RuntimeSendOpts): string | number | undefined {
  return opts.messageThreadId ?? opts.threadId ?? opts.threadTs ?? undefined;
}

function resolveRuntimeReplyToId(opts: RuntimeSendOpts): string | undefined {
  const raw = opts.replyToMessageId ?? opts.replyToId;
  return raw == null ? undefined : normalizeOptionalString(String(raw));
}

export function createChannelOutboundRuntimeSend(params: {
  channelId: ChannelId;
  unavailableMessage: string;
}) {
  return {
    sendMessage: async (to: string, text: string, opts: RuntimeSendOpts = {}) => {
      const outbound = await loadChannelOutboundAdapter(params.channelId);
      const threadId = resolveRuntimeThreadId(opts);
      const replyToId = resolveRuntimeReplyToId(opts);
      const buildContext = () => ({
        cfg: opts.cfg ?? getRuntimeConfig(),
        to,
        text,
        mediaUrl: opts.mediaUrl,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        accountId: opts.accountId,
        threadId,
        replyToId,
        silent: opts.silent,
        forceDocument: opts.forceDocument,
        gifPlayback: opts.gifPlayback,
        gatewayClientScopes: opts.gatewayClientScopes,
        // Channel-native fields forwarded to the outbound adapter so
        // plugins (e.g. Discord) can attach interactive components to a
        // plain-text send when the gateway proxies `send` through the
        // runtime layer.
        ...(opts.components !== undefined ? { components: opts.components } : {}),
        ...(opts.embeds !== undefined ? { embeds: opts.embeds } : {}),
        ...(opts.filename !== undefined ? { filename: opts.filename } : {}),
      });
      const hasMedia = Boolean(opts.mediaUrl);
      if (hasMedia && outbound?.sendMedia) {
        return await outbound.sendMedia(buildContext());
      }
      if (!outbound?.sendText) {
        throw new Error(params.unavailableMessage);
      }
      return await outbound.sendText(buildContext());
    },
  };
}
