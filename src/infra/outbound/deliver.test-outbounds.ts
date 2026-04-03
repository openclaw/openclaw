import { chunkMarkdownTextWithMode, chunkText } from "../../auto-reply/chunk.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { sanitizeForPlainText } from "../../plugin-sdk/outbound-runtime.js";
import { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";

type SignalSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

const MB = 1024 * 1024;

function resolveSignalMaxBytes(cfg: OpenClawConfig, accountId?: string): number | undefined {
  const signalCfg = cfg.channels?.signal as
    | {
        mediaMaxMb?: number;
        accounts?: Record<string, { mediaMaxMb?: number }>;
      }
    | undefined;
  const accountMb = accountId ? signalCfg?.accounts?.[accountId]?.mediaMaxMb : undefined;
  const mediaMaxMb = accountMb ?? signalCfg?.mediaMaxMb;
  return typeof mediaMaxMb === "number" ? mediaMaxMb * MB : undefined;
}

function resolveSignalSender(deps: OutboundSendDeps | undefined): SignalSendFn {
  const sender = resolveOutboundSendDep<SignalSendFn>(deps, "signal");
  if (!sender) {
    throw new Error("missing sendSignal dep");
  }
  return sender;
}

function resolveSignalTextChunkLimit(cfg: OpenClawConfig, accountId?: string | null): number {
  const signalCfg = cfg.channels?.signal as
    | {
        textChunkLimit?: number;
        accounts?: Record<string, { textChunkLimit?: number }>;
      }
    | undefined;
  const accountLimit = accountId ? signalCfg?.accounts?.[accountId]?.textChunkLimit : undefined;
  if (typeof accountLimit === "number") {
    return accountLimit;
  }
  return typeof signalCfg?.textChunkLimit === "number" ? signalCfg.textChunkLimit : 4000;
}

function withSignalChannel(result: Awaited<ReturnType<SignalSendFn>>) {
  return {
    channel: "signal" as const,
    ...result,
  };
}

// Keep deliver-core tests on a light local Signal stub. The real adapter owns
// markdown/style correctness in extensions/signal tests.
export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  sendFormattedText: async ({ cfg, to, text, accountId, deps, abortSignal }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes(cfg, accountId ?? undefined);
    const limit = resolveSignalTextChunkLimit(cfg, accountId);
    const chunks = chunkMarkdownTextWithMode(text, limit, "length");
    const outputChunks = chunks.length === 0 && text ? [text] : chunks;
    const results = [];
    for (const chunk of outputChunks) {
      abortSignal?.throwIfAborted();
      results.push(
        withSignalChannel(
          await send(to, chunk, {
            cfg,
            maxBytes,
            accountId: accountId ?? undefined,
            textMode: "plain",
            textStyles: [],
          }),
        ),
      );
    }
    return results;
  },
  sendFormattedMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    abortSignal,
  }) => {
    abortSignal?.throwIfAborted();
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes(cfg, accountId ?? undefined);
    return withSignalChannel(
      await send(to, text, {
        cfg,
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
        textMode: "plain",
        textStyles: [],
        mediaLocalRoots,
        mediaReadFile,
      }),
    );
  },
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes(cfg, accountId ?? undefined);
    return withSignalChannel(
      await send(to, text, {
        cfg,
        maxBytes,
        accountId: accountId ?? undefined,
      }),
    );
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
  }) => {
    const send = resolveSignalSender(deps);
    const maxBytes = resolveSignalMaxBytes(cfg, accountId ?? undefined);
    return withSignalChannel(
      await send(to, text, {
        cfg,
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
        mediaLocalRoots,
        mediaReadFile,
      }),
    );
  },
};

type WhatsAppSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveWhatsAppSender(deps: OutboundSendDeps | undefined): WhatsAppSendFn {
  const sender = resolveOutboundSendDep<WhatsAppSendFn>(deps, "whatsapp");
  if (!sender) {
    throw new Error("missing sendWhatsApp dep");
  }
  return sender;
}

function withWhatsAppChannel(result: Awaited<ReturnType<WhatsAppSendFn>>) {
  return {
    channel: "whatsapp" as const,
    ...result,
  };
}

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => sanitizeForPlainText(text),
  sendText: async ({ cfg, to, text, accountId, deps, gifPlayback }) => {
    const send = resolveWhatsAppSender(deps);
    return withWhatsAppChannel(
      await send(to, text, {
        verbose: false,
        cfg,
        accountId: accountId ?? undefined,
        gifPlayback,
      }),
    );
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    mediaReadFile,
    accountId,
    deps,
    gifPlayback,
  }) => {
    const send = resolveWhatsAppSender(deps);
    return withWhatsAppChannel(
      await send(to, text, {
        verbose: false,
        cfg,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        accountId: accountId ?? undefined,
        gifPlayback,
      }),
    );
  },
};

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  const sender = resolveOutboundSendDep<
    (
      to: string,
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<{ messageId: string; chatId?: string }>
  >(deps, "imessage");
  if (!sender) {
    throw new Error("missing sendIMessage dep");
  }
  return sender;
}

function resolveIMessageMaxBytes(cfg: OpenClawConfig): number | undefined {
  const channelMb = (cfg.channels?.imessage as { mediaMaxMb?: number } | undefined)?.mediaMaxMb;
  const agentMb = cfg.agents?.defaults?.mediaMaxMb;
  const mediaMaxMb = channelMb ?? agentMb;
  return typeof mediaMaxMb === "number" ? mediaMaxMb * MB : undefined;
}

export const imessageOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, replyToId, deps }) =>
    ({
      channel: "imessage",
      ...(await resolveIMessageSender(deps)(to, text, {
        config: cfg,
        maxBytes: resolveIMessageMaxBytes(cfg),
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      })),
    }) as const,
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, replyToId, deps }) =>
    ({
      channel: "imessage",
      ...(await resolveIMessageSender(deps)(to, text, {
        config: cfg,
        mediaUrl,
        mediaLocalRoots,
        maxBytes: resolveIMessageMaxBytes(cfg),
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      })),
    }) as const,
};
