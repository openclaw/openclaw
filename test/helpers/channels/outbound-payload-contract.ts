import { vi } from "vitest";
import {
  chunkTextForOutbound as chunkZaloTextForOutbound,
  sendPayloadWithChunkedTextAndMedia as sendZaloPayloadWithChunkedTextAndMedia,
} from "../../../extensions/zalo/runtime-api.js";
import { sendPayloadWithChunkedTextAndMedia as sendZalouserPayloadWithChunkedTextAndMedia } from "../../../extensions/zalouser/runtime-api.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { createSlackOutboundPayloadHarness } from "../../../src/channels/plugins/contracts/slack-outbound-harness.js";
import { installChannelOutboundPayloadContractSuite } from "../../../src/channels/plugins/contracts/suites.js";
import { primeChannelOutboundSendMock } from "../../../src/channels/plugins/contracts/test-helpers.js";
import { createDirectTextMediaOutbound } from "../../../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";
type ParseZalouserOutboundTarget = (raw: string) => { threadId: string; isGroup: boolean };

let discordOutboundCache: ChannelOutboundAdapter | undefined;
let whatsappOutboundCache: ChannelOutboundAdapter | undefined;
let parseZalouserOutboundTargetCache: ParseZalouserOutboundTarget | undefined;

function getDiscordOutbound(): ChannelOutboundAdapter {
  if (!discordOutboundCache) {
    ({ discordOutbound: discordOutboundCache } = loadBundledPluginTestApiSync<{
      discordOutbound: ChannelOutboundAdapter;
    }>("discord"));
  }
  return discordOutboundCache;
}

function getWhatsAppOutbound(): ChannelOutboundAdapter {
  if (!whatsappOutboundCache) {
    ({ whatsappOutbound: whatsappOutboundCache } = loadBundledPluginTestApiSync<{
      whatsappOutbound: ChannelOutboundAdapter;
    }>("whatsapp"));
  }
  return whatsappOutboundCache;
}

function getParseZalouserOutboundTarget(): ParseZalouserOutboundTarget {
  if (!parseZalouserOutboundTargetCache) {
    ({ parseZalouserOutboundTarget: parseZalouserOutboundTargetCache } =
      loadBundledPluginTestApiSync<{
        parseZalouserOutboundTarget: ParseZalouserOutboundTarget;
      }>("zalouser"));
  }
  return parseZalouserOutboundTargetCache;
}

type PayloadHarnessParams = {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
};

function buildChannelSendResult(channel: string, result: Record<string, unknown>) {
  return {
    channel,
    messageId: typeof result.messageId === "string" ? result.messageId : "",
  };
}

function createDiscordHarness(params: PayloadHarnessParams) {
  const sendDiscord = vi.fn();
  primeChannelOutboundSendMock(
    sendDiscord,
    { messageId: "dc-1", channelId: "123456" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: params.payload,
    deps: {
      sendDiscord,
    },
  };
  return {
    run: async () => await getDiscordOutbound().sendPayload!(ctx),
    sendMock: sendDiscord,
    to: ctx.to,
  };
}

function createWhatsAppHarness(params: PayloadHarnessParams) {
  const sendWhatsApp = vi.fn();
  primeChannelOutboundSendMock(sendWhatsApp, { messageId: "wa-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "5511999999999@c.us",
    text: "",
    payload: params.payload,
    deps: {
      sendWhatsApp,
    },
  };
  return {
    run: async () => await getWhatsAppOutbound().sendPayload!(ctx),
    sendMock: sendWhatsApp,
    to: ctx.to,
  };
}

function createDirectTextMediaHarness(params: PayloadHarnessParams) {
  const sendFn = vi.fn();
  primeChannelOutboundSendMock(sendFn, { messageId: "m1" }, params.sendResults);
  const outbound = createDirectTextMediaOutbound({
    channel: "imessage",
    resolveSender: () => sendFn,
    resolveMaxBytes: () => undefined,
    buildTextOptions: (opts) => opts as never,
    buildMediaOptions: (opts) => opts as never,
  });
  const ctx = {
    cfg: {},
    to: "user1",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () => await outbound.sendPayload!(ctx),
    sendMock: sendFn,
    to: ctx.to,
  };
}

function createZaloHarness(params: PayloadHarnessParams) {
  const sendZalo = vi.fn();
  primeChannelOutboundSendMock(sendZalo, { ok: true, messageId: "zl-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "123456789",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () =>
      await sendZaloPayloadWithChunkedTextAndMedia({
        ctx,
        textChunkLimit: 2000,
        chunker: chunkZaloTextForOutbound,
        sendText: async (nextCtx) =>
          buildChannelSendResult(
            "zalo",
            await sendZalo(nextCtx.to, nextCtx.text, {
              accountId: undefined,
              cfg: nextCtx.cfg,
            }),
          ),
        sendMedia: async (nextCtx) =>
          buildChannelSendResult(
            "zalo",
            await sendZalo(nextCtx.to, nextCtx.text, {
              accountId: undefined,
              cfg: nextCtx.cfg,
              mediaUrl: nextCtx.mediaUrl,
            }),
          ),
        emptyResult: { channel: "zalo", messageId: "" },
      }),
    sendMock: sendZalo,
    to: ctx.to,
  };
}

function createZalouserHarness(params: PayloadHarnessParams) {
  const sendZalouser = vi.fn();
  primeChannelOutboundSendMock(sendZalouser, { ok: true, messageId: "zlu-1" }, params.sendResults);
  const ctx = {
    cfg: {},
    to: "user:987654321",
    text: "",
    payload: params.payload,
  };
  return {
    run: async () =>
      await sendZalouserPayloadWithChunkedTextAndMedia({
        ctx,
        sendText: async (nextCtx) => {
          const target = getParseZalouserOutboundTarget()(nextCtx.to);
          return buildChannelSendResult(
            "zalouser",
            await sendZalouser(target.threadId, nextCtx.text, {
              profile: "default",
              isGroup: target.isGroup,
              textMode: "markdown",
              textChunkMode: "length",
              textChunkLimit: 1200,
            }),
          );
        },
        sendMedia: async (nextCtx) => {
          const target = getParseZalouserOutboundTarget()(nextCtx.to);
          return buildChannelSendResult(
            "zalouser",
            await sendZalouser(target.threadId, nextCtx.text, {
              profile: "default",
              isGroup: target.isGroup,
              mediaUrl: nextCtx.mediaUrl,
              textMode: "markdown",
              textChunkMode: "length",
              textChunkLimit: 1200,
            }),
          );
        },
        emptyResult: { channel: "zalouser", messageId: "" },
      }),
    sendMock: sendZalouser,
    to: "987654321",
  };
}

export function installSlackOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "slack",
    chunking: { mode: "passthrough", longTextLength: 5000 },
    createHarness: createSlackOutboundPayloadHarness,
  });
}

export function installDiscordOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "discord",
    chunking: { mode: "passthrough", longTextLength: 3000 },
    createHarness: createDiscordHarness,
  });
}

export function installWhatsAppOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "whatsapp",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createWhatsAppHarness,
  });
}

export function installZaloOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "zalo",
    chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
    createHarness: createZaloHarness,
  });
}

export function installZalouserOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "zalouser",
    chunking: { mode: "passthrough", longTextLength: 3000 },
    createHarness: createZalouserHarness,
  });
}

export function installDirectTextMediaOutboundPayloadContractSuite() {
  installChannelOutboundPayloadContractSuite({
    channel: "imessage",
    chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
    createHarness: createDirectTextMediaHarness,
  });
}
