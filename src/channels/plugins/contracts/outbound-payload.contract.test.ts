import { describe, vi } from "vitest";
import { discordOutbound } from "../../../../extensions/discord/src/outbound-adapter.js";
import { whatsappOutbound } from "../../../../extensions/whatsapp/src/outbound-adapter.js";
import { zaloPlugin } from "../../../../extensions/zalo/src/channel.js";
import { sendMessageZalo } from "../../../../extensions/zalo/src/send.js";
import "./../../../../extensions/zalouser/src/accounts.test-mocks.js";
import { zalouserPlugin } from "../../../../extensions/zalouser/src/channel.js";
import { setZalouserRuntime } from "../../../../extensions/zalouser/src/runtime.js";
import { sendMessageZalouser } from "../../../../extensions/zalouser/src/send.js";
import { slackOutbound } from "../../../../test/channel-outbounds.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { createDirectTextMediaOutbound } from "../outbound/direct-text-media.js";
import {
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
} from "./suites.js";

vi.mock("../../../../extensions/zalo/src/send.js", () => ({
  sendMessageZalo: vi.fn().mockResolvedValue({ ok: true, messageId: "zl-1" }),
}));

vi.mock("../../../../extensions/zalouser/src/send.js", () => ({
  sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" }),
  sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true }),
}));

type PayloadHarnessParams = {
  payload: ReplyPayload;
  sendResults?: Array<{ messageId: string }>;
};

const mockedSendZalo = vi.mocked(sendMessageZalo);
const mockedSendZalouser = vi.mocked(sendMessageZalouser);

function createSlackHarness(params: PayloadHarnessParams) {
  const sendSlack = vi.fn();
  primeChannelOutboundSendMock(
    sendSlack,
    { messageId: "sl-1", channelId: "C12345", ts: "1234.5678" },
    params.sendResults,
  );
  const ctx = {
    cfg: {},
    to: "C12345",
    text: "",
    payload: params.payload,
    deps: {
      sendSlack,
    },
  };
  return {
    run: async () => await slackOutbound.sendPayload!(ctx),
    sendMock: sendSlack,
    to: ctx.to,
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
    run: async () => await discordOutbound.sendPayload!(ctx),
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
    run: async () => await whatsappOutbound.sendPayload!(ctx),
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

describe("channel outbound payload contract", () => {
  describe("slack", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "slack",
      chunking: { mode: "passthrough", longTextLength: 5000 },
      createHarness: createSlackHarness,
    });
  });

  describe("discord", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "discord",
      chunking: { mode: "passthrough", longTextLength: 3000 },
      createHarness: createDiscordHarness,
    });
  });

  describe("whatsapp", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "whatsapp",
      chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
      createHarness: createWhatsAppHarness,
    });
  });

  describe("zalo", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "zalo",
      chunking: { mode: "split", longTextLength: 3000, maxChunkLength: 2000 },
      createHarness: ({ payload, sendResults }) => {
        primeChannelOutboundSendMock(mockedSendZalo, { ok: true, messageId: "zl-1" }, sendResults);
        return {
          run: async () =>
            await zaloPlugin.outbound!.sendPayload!({
              cfg: {},
              to: "123456789",
              text: "",
              payload,
            }),
          sendMock: mockedSendZalo,
          to: "123456789",
        };
      },
    });
  });

  describe("zalouser", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "zalouser",
      chunking: { mode: "passthrough", longTextLength: 3000 },
      createHarness: ({ payload, sendResults }) => {
        setZalouserRuntime({
          channel: {
            text: {
              resolveChunkMode: vi.fn(() => "length"),
              resolveTextChunkLimit: vi.fn(() => 1200),
            },
          },
        } as never);
        primeChannelOutboundSendMock(
          mockedSendZalouser,
          { ok: true, messageId: "zlu-1" },
          sendResults,
        );
        return {
          run: async () =>
            await zalouserPlugin.outbound!.sendPayload!({
              cfg: {},
              to: "user:987654321",
              text: "",
              payload,
            }),
          sendMock: mockedSendZalouser,
          to: "987654321",
        };
      },
    });
  });

  describe("direct-text-media", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "imessage",
      chunking: { mode: "split", longTextLength: 5000, maxChunkLength: 4000 },
      createHarness: createDirectTextMediaHarness,
    });
  });
});
