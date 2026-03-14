import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalOutbound } from "../../channels/plugins/outbound/signal.js";
import { telegramOutbound } from "../../channels/plugins/outbound/telegram.js";
import { whatsappOutbound } from "../../channels/plugins/outbound/whatsapp.js";
import type { OpenClawConfig } from "../../config/config.js";
import { STATE_DIR } from "../../config/paths.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { markdownToSignalTextChunks } from "../../signal/format.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createIMessageTestPlugin } from "../../test-utils/imessage-test-plugin.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageSent: vi.fn(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const queueMocks = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(async () => "mock-queue-id"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
}));
const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("./delivery-queue.js", () => ({
  enqueueDelivery: queueMocks.enqueueDelivery,
  ackDelivery: queueMocks.ackDelivery,
  failDelivery: queueMocks.failDelivery,
}));
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const makeLogger = () => ({
      warn: logMocks.warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(() => makeLogger()),
    });
    return makeLogger();
  },
}));

const { deliverOutboundPayloads, normalizeOutboundPayloads } = await import("./deliver.js");

const telegramChunkConfig: OpenClawConfig = {
  channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
};

const whatsappChunkConfig: OpenClawConfig = {
  channels: { whatsapp: { textChunkLimit: 4000 } },
};

type DeliverOutboundArgs = Parameters<typeof deliverOutboundPayloads>[0];
type DeliverOutboundPayload = DeliverOutboundArgs["payloads"][number];
type DeliverSession = DeliverOutboundArgs["session"];

async function deliverWhatsAppPayload(params: {
  sendWhatsApp: NonNullable<
    NonNullable<Parameters<typeof deliverOutboundPayloads>[0]["deps"]>["sendWhatsApp"]
  >;
  payload: { text: string; mediaUrl?: string };
  cfg?: OpenClawConfig;
}) {
  return deliverOutboundPayloads({
    cfg: params.cfg ?? whatsappChunkConfig,
    channel: "whatsapp",
    to: "+1555",
    payloads: [params.payload],
    deps: { sendWhatsApp: params.sendWhatsApp },
  });
}

async function deliverTelegramPayload(params: {
  sendTelegram: NonNullable<NonNullable<DeliverOutboundArgs["deps"]>["sendTelegram"]>;
  payload: DeliverOutboundPayload;
  cfg?: OpenClawConfig;
  accountId?: string;
  session?: DeliverSession;
}) {
  return deliverOutboundPayloads({
    cfg: params.cfg ?? telegramChunkConfig,
    channel: "telegram",
    to: "123",
    payloads: [params.payload],
    deps: { sendTelegram: params.sendTelegram },
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.session ? { session: params.session } : {}),
  });
}

describe("deliverOutboundPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSent.mockClear();
    hookMocks.runner.runMessageSent.mockResolvedValue(undefined);
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    queueMocks.enqueueDelivery.mockClear();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.ackDelivery.mockClear();
    queueMocks.ackDelivery.mockResolvedValue(undefined);
    queueMocks.failDelivery.mockClear();
    queueMocks.failDelivery.mockResolvedValue(undefined);
    logMocks.warn.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });
  it("chunks telegram markdown and passes through accountId", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    await withEnvAsync({ TELEGRAM_BOT_TOKEN: "" }, async () => {
      const results = await deliverOutboundPayloads({
        cfg: telegramChunkConfig,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "abcd" }],
        deps: { sendTelegram },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      for (const call of sendTelegram.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ accountId: undefined, verbose: false, textMode: "html" }),
        );
      }
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ channel: "telegram", chatId: "c1" });
    });
  });

  it("clamps telegram text chunk size to protocol max even with higher config", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 10_000 } },
    };
    const text = "<".repeat(3_000);
    await withEnvAsync({ TELEGRAM_BOT_TOKEN: "" }, async () => {
      await deliverOutboundPayloads({
        cfg,
        channel: "telegram",
        to: "123",
        payloads: [{ text }],
        deps: { sendTelegram },
      });
    });

    expect(sendTelegram.mock.calls.length).toBeGreaterThan(1);
    const sentHtmlChunks = sendTelegram.mock.calls
      .map((call) => call[1])
      .filter((message): message is string => typeof message === "string");
    expect(sentHtmlChunks.length).toBeGreaterThan(1);
    expect(sentHtmlChunks.every((message) => message.length <= 4096)).toBe(true);
  });

  it("keeps payload replyToId across all chunked telegram sends", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    await withEnvAsync({ TELEGRAM_BOT_TOKEN: "" }, async () => {
      await deliverOutboundPayloads({
        cfg: telegramChunkConfig,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "abcd", replyToId: "777" }],
        deps: { sendTelegram },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      for (const call of sendTelegram.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ replyToMessageId: 777 }));
      }
    });
  });

  it("passes explicit accountId to sendTelegram", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverTelegramPayload({
      sendTelegram,
      accountId: "default",
      payload: { text: "hi" },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ accountId: "default", verbose: false, textMode: "html" }),
    );
  });

  it("preserves HTML text for telegram sendPayload channelData path", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverTelegramPayload({
      sendTelegram,
      payload: {
        text: "<b>hello</b>",
        channelData: { telegram: { buttons: [] } },
      },
    });

    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "<b>hello</b>",
      expect.objectContaining({ textMode: "html" }),
    );
  });

  it("does not inject telegram approval buttons from plain approval text", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverTelegramPayload({
      sendTelegram,
      cfg: {
        channels: {
          telegram: {
            botToken: "tok-1",
            execApprovals: {
              enabled: true,
              approvers: ["123"],
              target: "dm",
            },
          },
        },
      },
      payload: {
        text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
      },
    });

    const sendOpts = sendTelegram.mock.calls[0]?.[2] as { buttons?: unknown } | undefined;
    expect(sendOpts?.buttons).toBeUndefined();
  });

  it("preserves explicit telegram buttons when sender path provides them", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["123"],
            target: "dm",
          },
        },
      },
    };

    await deliverTelegramPayload({
      sendTelegram,
      cfg,
      payload: {
        text: "Approval required",
        channelData: {
          telegram: {
            buttons: [
              [
                { text: "Allow Once", callback_data: "/approve 117ba06d allow-once" },
                { text: "Allow Always", callback_data: "/approve 117ba06d allow-always" },
              ],
              [{ text: "Deny", callback_data: "/approve 117ba06d deny" }],
            ],
          },
        },
      },
    });

    const sendOpts = sendTelegram.mock.calls[0]?.[2] as { buttons?: unknown } | undefined;
    expect(sendOpts?.buttons).toEqual([
      [
        { text: "Allow Once", callback_data: "/approve 117ba06d allow-once" },
        { text: "Allow Always", callback_data: "/approve 117ba06d allow-always" },
      ],
      [{ text: "Deny", callback_data: "/approve 117ba06d deny" }],
    ]);
  });

  it("scopes media local roots to the active agent workspace when agentId is provided", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverTelegramPayload({
      sendTelegram,
      session: { agentId: "work" },
      payload: { text: "hi", mediaUrl: "file:///tmp/f.png" },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({
        mediaUrl: "file:///tmp/f.png",
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
      }),
    );
  });

  it("includes OpenClaw tmp root in telegram mediaLocalRoots", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverTelegramPayload({
      sendTelegram,
      payload: { text: "hi", mediaUrl: "https://example.com/x.png" },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([resolvePreferredOpenClawTmpDir()]),
      }),
    );
  });

  it("includes OpenClaw tmp root in signal mediaLocalRoots", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });

    await deliverOutboundPayloads({
      cfg: { channels: { signal: {} } },
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([resolvePreferredOpenClawTmpDir()]),
      }),
    );
  });

  it("includes OpenClaw tmp root in whatsapp mediaLocalRoots", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: whatsappChunkConfig,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([resolvePreferredOpenClawTmpDir()]),
      }),
    );
  });

  it("includes OpenClaw tmp root in imessage mediaLocalRoots", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "i1", chatId: "chat-1" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "imessage",
      to: "imessage:+15551234567",
      payloads: [{ text: "hi", mediaUrl: "https://example.com/x.png" }],
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "imessage:+15551234567",
      "hi",
      expect.objectContaining({
        mediaLocalRoots: expect.arrayContaining([resolvePreferredOpenClawTmpDir()]),
      }),
    );
  });

  it("routes iMessage audioAsVoice payloads through sendPayload semantics", async () => {
    const sendIMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "voice-1" })
      .mockResolvedValueOnce({ messageId: "text-1" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "imessage",
      to: "chat_id:42",
      payloads: [
        {
          text: "voice caption",
          mediaUrl: "https://example.com/voice.m4a",
          audioAsVoice: true,
        },
      ],
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledTimes(2);
    expect(sendIMessage).toHaveBeenNthCalledWith(
      1,
      "chat_id:42",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/voice.m4a",
        audioAsVoice: true,
      }),
    );
    expect(sendIMessage).toHaveBeenNthCalledWith(
      2,
      "chat_id:42",
      "voice caption",
      expect.not.objectContaining({
        mediaUrl: expect.anything(),
      }),
    );
  });

  it("chunks iMessage text using configured textChunkLimit", async () => {
    const sendIMessage = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "i1" })
      .mockResolvedValueOnce({ messageId: "i2" });

    await deliverOutboundPayloads({
      cfg: { channels: { imessage: { textChunkLimit: 2 } } },
      channel: "imessage",
      to: "chat_id:42",
      payloads: [{ text: "abcd" }],
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledTimes(2);
    expect(sendIMessage).toHaveBeenNthCalledWith(
      1,
      "chat_id:42",
      "ab",
      expect.objectContaining({ accountId: undefined }),
    );
    expect(sendIMessage).toHaveBeenNthCalledWith(
      2,
      "chat_id:42",
      "cd",
      expect.objectContaining({ accountId: undefined }),
    );
  });

  it("preserves empty channelData-only payloads for imessage without sending", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "unexpected" });

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "imessage",
      to: "chat_id:42",
      payloads: [{ text: " \n\t ", channelData: { mode: "custom" } }],
      deps: { sendIMessage },
    });

    expect(sendIMessage).not.toHaveBeenCalled();
    expect(results).toEqual([{ channel: "imessage", messageId: "" }]);
  });

  it("uses signal media maxBytes from config", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: OpenClawConfig = { channels: { signal: { mediaMaxMb: 2 } } };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaUrl: "https://x.test/a.jpg",
        maxBytes: 2 * 1024 * 1024,
        textMode: "plain",
        textStyles: [],
      }),
    );
    expect(results[0]).toMatchObject({ channel: "signal", messageId: "s1" });
  });

  it("chunks Signal markdown using the format-first chunker", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: OpenClawConfig = {
      channels: { signal: { textChunkLimit: 20 } },
    };
    const text = `Intro\\n\\n\`\`\`\`md\\n${"y".repeat(60)}\\n\`\`\`\\n\\nOutro`;
    const expectedChunks = markdownToSignalTextChunks(text, 20);

    await deliverOutboundPayloads({
      cfg,
      channel: "signal",
      to: "+1555",
      payloads: [{ text }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledTimes(expectedChunks.length);
    expectedChunks.forEach((chunk, index) => {
      expect(sendSignal).toHaveBeenNthCalledWith(
        index + 1,
        "+1555",
        chunk.text,
        expect.objectContaining({
          accountId: undefined,
          textMode: "plain",
          textStyles: chunk.styles,
        }),
      );
    });
  });

  it("chunks WhatsApp text and returns all results", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "w1", toJid: "jid" })
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { textChunkLimit: 2 } },
    };
    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "abcd" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["w1", "w2"]);
  });

  it("respects newline chunk mode for WhatsApp", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { textChunkLimit: 4000, chunkMode: "newline" } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "Line one\n\nLine two" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "Line one",
      expect.objectContaining({ verbose: false }),
    );
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      2,
      "+1555",
      "Line two",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("strips leading blank lines for WhatsApp text payloads", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: "\n\nHello from WhatsApp" },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "Hello from WhatsApp",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("drops whitespace-only WhatsApp text payloads when no media is attached", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const results = await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: "   \n\t   " },
    });

    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("drops HTML-only WhatsApp text payloads after sanitization", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const results = await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: "<br><br>" },
    });

    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("keeps WhatsApp media payloads but clears whitespace-only captions", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: " \n\t ", mediaUrl: "https://example.com/photo.png" },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/photo.png",
        verbose: false,
      }),
    );
  });

  it("drops non-WhatsApp HTML-only text payloads after sanitization", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", toJid: "jid" });
    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "<br>" }],
      deps: { sendSignal },
    });

    expect(sendSignal).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("preserves fenced blocks for markdown chunkers in newline mode", async () => {
    const chunker = vi.fn((text: string) => (text ? [text] : []));
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    const sendMedia = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker,
              chunkerMode: "markdown",
              textChunkLimit: 4000,
              sendText,
              sendMedia,
            },
          }),
        },
      ]),
    );

    const cfg: OpenClawConfig = {
      channels: { matrix: { textChunkLimit: 4000, chunkMode: "newline" } },
    };
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room",
      payloads: [{ text }],
    });

    expect(chunker).toHaveBeenCalledTimes(1);
    expect(chunker).toHaveBeenNthCalledWith(1, text, 4000);
  });

  it("uses iMessage media maxBytes from agent fallback", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "i1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "imessage",
      to: "chat_id:42",
      payloads: [{ text: "hello" }],
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hello",
      expect.objectContaining({ maxBytes: 3 * 1024 * 1024 }),
    );
  });

  it("normalizes payloads and drops empty entries", () => {
    const normalized = normalizeOutboundPayloads([
      { text: "hi" },
      { text: "MEDIA:https://x.test/a.jpg" },
      { text: " ", mediaUrls: [] },
    ]);
    expect(normalized).toEqual([
      { text: "hi", mediaUrls: [] },
      { text: "", mediaUrls: ["https://x.test/a.jpg"] },
    ]);
  });

  it("preserves channelData-only payloads with empty text for non-WhatsApp sendPayload channels", async () => {
    const sendPayload = vi.fn().mockResolvedValue({ channel: "line", messageId: "ln-1" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "line",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "line",
      to: "U123",
      payloads: [{ text: " \n\t ", channelData: { mode: "flex" } }],
    });

    expect(sendPayload).toHaveBeenCalledTimes(1);
    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ text: "", channelData: { mode: "flex" } }),
      }),
    );
    expect(results).toEqual([{ channel: "line", messageId: "ln-1" }]);
  });

  it("falls back to sendText when plugin outbound omits sendMedia", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/file.png" }],
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption",
      }),
    );
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
      expect.objectContaining({
        channel: "matrix",
        mediaCount: 1,
      }),
    );
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-1" }]);
  });

  it("falls back to one sendText call for multi-media payloads when sendMedia is omitted", async () => {
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-2" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    const results = await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
      ],
    });

    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "caption",
      }),
    );
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
      expect.objectContaining({
        channel: "matrix",
        mediaCount: 2,
      }),
    );
    expect(results).toEqual([{ channel: "matrix", messageId: "mx-2" }]);
  });

  it("fails media-only payloads when plugin outbound omits sendMedia", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    const sendText = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-3" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "matrix",
        to: "!room:1",
        payloads: [{ text: "   ", mediaUrl: "https://example.com/file.png" }],
      }),
    ).rejects.toThrow(
      "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
    );

    expect(sendText).not.toHaveBeenCalled();
    expect(logMocks.warn).toHaveBeenCalledWith(
      "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
      expect.objectContaining({
        channel: "matrix",
        mediaCount: 1,
      }),
    );
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "!room:1",
        content: "",
        success: false,
        error:
          "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
      }),
      expect.objectContaining({ channelId: "matrix" }),
    );
  });
});

const emptyRegistry = createTestRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
  {
    pluginId: "signal",
    plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
    source: "test",
  },
  {
    pluginId: "whatsapp",
    plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
    source: "test",
  },
  {
    pluginId: "imessage",
    plugin: createIMessageTestPlugin(),
    source: "test",
  },
]);
