import { vi } from "vitest";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import {
  createSlackOutboundPayloadHarness,
  installChannelOutboundPayloadContractSuite,
  primeChannelOutboundSendMock,
} from "../../../src/channels/plugins/contracts/suites.js";
import { createDirectTextMediaOutbound } from "../../../src/channels/plugins/outbound/direct-text-media.js";
import type { ChannelOutboundAdapter } from "../../../src/channels/plugins/types.js";
import {
  chunkTextForOutbound as chunkZaloTextForOutbound,
  sendPayloadWithChunkedTextAndMedia as sendZaloPayloadWithChunkedTextAndMedia,
} from "../../../src/plugin-sdk/zalo.js";
import { sendPayloadWithChunkedTextAndMedia as sendZalouserPayloadWithChunkedTextAndMedia } from "../../../src/plugin-sdk/zalouser.js";
import {
  loadBundledPluginTestApiSync,
  resolveRelativeBundledPluginPublicModuleId,
} from "../../../src/test-utils/bundled-plugin-public-surface.js";

type ChannelSendResponse = { ok?: boolean; messageId?: string };
type SendMessageZalo = (
  to: string,
  text: string,
  options: Record<string, unknown>,
) => Promise<ChannelSendResponse>;
type SendMessageZalouser = (
  threadId: string,
  text: string,
  options: Record<string, unknown>,
) => Promise<ChannelSendResponse>;
type ParseZalouserOutboundTarget = (raw: string) => { threadId: string; isGroup: boolean };

const { discordOutbound } = loadBundledPluginTestApiSync<{
  discordOutbound: ChannelOutboundAdapter;
}>("discord");
const { whatsappOutbound } = loadBundledPluginTestApiSync<{
  whatsappOutbound: ChannelOutboundAdapter;
}>("whatsapp");
const { sendMessageZalo } = loadBundledPluginTestApiSync<{
  sendMessageZalo: SendMessageZalo;
}>("zalo");
const { sendMessageZalouser, parseZalouserOutboundTarget } = loadBundledPluginTestApiSync<{
  sendMessageZalouser: SendMessageZalouser;
  parseZalouserOutboundTarget: ParseZalouserOutboundTarget;
}>("zalouser");

const zaloTestApiModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "zalo",
  artifactBasename: "test-api.js",
});
const zalouserTestApiModuleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "zalouser",
  artifactBasename: "test-api.js",
});

vi.mock(zaloTestApiModuleId, async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    sendMessageZalo: vi.fn().mockResolvedValue({ ok: true, messageId: "zl-1" }),
  };
});

vi.mock(zalouserTestApiModuleId, async (importOriginal) => {
  const actual = await importOriginal<object>();
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
  const mockedSendZalo = vi.mocked(sendMessageZalo);
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
  const mockedSendZalouser = vi.mocked(sendMessageZalouser);
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
