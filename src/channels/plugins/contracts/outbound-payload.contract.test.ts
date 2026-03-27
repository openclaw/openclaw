import { describe, vi } from "vitest";
import { discordOutbound } from "../../../../extensions/discord/test-api.js";
import { whatsappOutbound } from "../../../../extensions/whatsapp/test-api.js";
import { sendMessageZalo } from "../../../../extensions/zalo/test-api.js";
import {
  sendMessageZalouser,
  parseZalouserOutboundTarget,
} from "../../../../extensions/zalouser/test-api.js";
import {
  chunkTextForOutbound as chunkZaloTextForOutbound,
  sendPayloadWithChunkedTextAndMedia as sendZaloPayloadWithChunkedTextAndMedia,
} from "../../../../src/plugin-sdk/zalo.js";
import { sendPayloadWithChunkedTextAndMedia as sendZalouserPayloadWithChunkedTextAndMedia } from "../../../../src/plugin-sdk/zalouser.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { createDirectTextMediaOutbound } from "../outbound/direct-text-media.js";
import {
  createSlackOutboundPayloadHarness,
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
} from "./suites.js";

vi.mock("../../../../extensions/zalo/test-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../extensions/zalo/test-api.js")>();
  return {
    ...actual,
    sendMessageZalo: vi.fn().mockResolvedValue({ ok: true, messageId: "zl-1" }),
  };
});

// This suite only validates payload adaptation. Keep zalouser's runtime-only
// ZCA import graph mocked so local contract runs don't depend on native socket
// deps being resolved through the extension runtime seam.
vi.mock("../../../../extensions/zalouser/test-api.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../extensions/zalouser/test-api.js")>();
  return {
    ...actual,
    listZalouserAccountIds: vi.fn(() => ["default"]),
    resolveDefaultZalouserAccountId: vi.fn(() => "default"),
    resolveZalouserAccountSync: vi.fn(() => ({
      accountId: "default",
      profile: "default",
      name: "test",
      enabled: true,
      authenticated: true,
      config: {},
    })),
    getZcaUserInfo: vi.fn(async () => null),
    checkZcaAuthenticated: vi.fn(async () => false),
    checkZaloAuthenticated: vi.fn(async () => false),
    getZaloUserInfo: vi.fn(async () => null),
    listZaloFriendsMatching: vi.fn(async () => []),
    listZaloGroupMembers: vi.fn(async () => []),
    listZaloGroupsMatching: vi.fn(async () => []),
    logoutZaloProfile: vi.fn(async () => {}),
    resolveZaloAllowFromEntries: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ input: entry, resolved: true, id: entry, note: undefined })),
    ),
    resolveZaloGroupsByEntries: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ input: entry, resolved: true, id: entry, note: undefined })),
    ),
    startZaloQrLogin: vi.fn(async () => ({
      message: "qr pending",
      qrDataUrl: undefined,
    })),
    waitForZaloQrLogin: vi.fn(async () => ({
      connected: false,
      message: "login pending",
    })),
    sendMessageZalouser: vi.fn().mockResolvedValue({ ok: true, messageId: "zlu-1" }),
    sendReactionZalouser: vi.fn().mockResolvedValue({ ok: true }),
  };
});

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

const mockedSendZalo = vi.mocked(sendMessageZalo);
const mockedSendZalouser = vi.mocked(sendMessageZalouser);

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

function createZaloHarness(params: PayloadHarnessParams) {
  primeChannelOutboundSendMock(mockedSendZalo, { ok: true, messageId: "zl-1" }, params.sendResults);
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
            await mockedSendZalo(nextCtx.to, nextCtx.text, {
              accountId: undefined,
              cfg: nextCtx.cfg,
            }),
          ),
        sendMedia: async (nextCtx) =>
          buildChannelSendResult(
            "zalo",
            await mockedSendZalo(nextCtx.to, nextCtx.text, {
              accountId: undefined,
              cfg: nextCtx.cfg,
              mediaUrl: nextCtx.mediaUrl,
            }),
          ),
        emptyResult: { channel: "zalo", messageId: "" },
      }),
    sendMock: mockedSendZalo,
    to: ctx.to,
  };
}

function createZalouserHarness(params: PayloadHarnessParams) {
  primeChannelOutboundSendMock(
    mockedSendZalouser,
    { ok: true, messageId: "zlu-1" },
    params.sendResults,
  );
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
          const target = parseZalouserOutboundTarget(nextCtx.to);
          return buildChannelSendResult(
            "zalouser",
            await mockedSendZalouser(target.threadId, nextCtx.text, {
              profile: "default",
              isGroup: target.isGroup,
              textMode: "markdown",
              textChunkMode: "length",
              textChunkLimit: 1200,
            }),
          );
        },
        sendMedia: async (nextCtx) => {
          const target = parseZalouserOutboundTarget(nextCtx.to);
          return buildChannelSendResult(
            "zalouser",
            await mockedSendZalouser(target.threadId, nextCtx.text, {
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
    sendMock: mockedSendZalouser,
    to: "987654321",
  };
}

describe("channel outbound payload contract", () => {
  describe("slack", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "slack",
      chunking: { mode: "passthrough", longTextLength: 5000 },
      createHarness: createSlackOutboundPayloadHarness,
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
      createHarness: createZaloHarness,
    });
  });

  describe("zalouser", () => {
    installChannelOutboundPayloadContractSuite({
      channel: "zalouser",
      chunking: { mode: "passthrough", longTextLength: 3000 },
      createHarness: createZalouserHarness,
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
