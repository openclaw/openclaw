import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { signalOutbound } from "../../channels/plugins/outbound/signal.js";
import { telegramOutbound } from "../../channels/plugins/outbound/telegram.js";
import { whatsappOutbound } from "../../channels/plugins/outbound/whatsapp.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { markdownToSignalTextChunks } from "../../signal/format.js";
import {
  createIMessageTestPlugin,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));

const hitlMocks = vi.hoisted(() => ({
  decision: "allow-once" as "allow-once" | "allow-always" | "deny" | null,
  createHitlRequest: vi.fn(async () => ({ ok: true, requestId: "r1", raw: {} })),
  allowlist: {
    loadHitlAllowlist: vi.fn(() => ({ version: 1, entries: [] })),
    matchesHitlAllowlist: vi.fn(() => false),
    addHitlAllowlistEntry: vi.fn(),
  },
  manager: {
    create: vi.fn((params: unknown) => {
      type HitlCreateParams = {
        kind: "outbound" | "plugin-http";
        timeoutMs: number;
        defaultDecision: "allow-once" | "allow-always" | "deny";
        summary: Record<string, unknown>;
      };
      const p = params as HitlCreateParams;
      return {
        id: "a1",
        kind: p.kind,
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + p.timeoutMs,
        defaultDecision: p.defaultDecision,
        summary: p.summary,
      };
    }),
    waitForDecision: vi.fn(async () => hitlMocks.decision),
    attachHitlRequestId: vi.fn(() => true),
  },
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

vi.mock("../hitl/client.js", () => ({
  createHitlRequest: hitlMocks.createHitlRequest,
}));

vi.mock("../hitl/allowlist.js", () => ({
  loadHitlAllowlist: hitlMocks.allowlist.loadHitlAllowlist,
  matchesHitlAllowlist: hitlMocks.allowlist.matchesHitlAllowlist,
  addHitlAllowlistEntry: hitlMocks.allowlist.addHitlAllowlistEntry,
}));

vi.mock("../hitl/state.js", () => ({
  hitlApprovalManager: hitlMocks.manager,
}));

const { deliverOutboundPayloads, normalizeOutboundPayloads } = await import("./deliver.js");

describe("deliverOutboundPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });
  it("chunks telegram markdown and passes through accountId", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
    };
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      const results = await deliverOutboundPayloads({
        cfg,
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
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("passes explicit accountId to sendTelegram", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "telegram",
      to: "123",
      accountId: "default",
      payloads: [{ text: "hi" }],
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ accountId: "default", verbose: false, textMode: "html" }),
    );
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

  it("continues on errors when bestEffort is enabled", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "a" }, { text: "b" }],
      deps: { sendWhatsApp },
      bestEffort: true,
      onError,
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "whatsapp", messageId: "w2", toJid: "jid" }]);
  });

  it("passes normalized payload to onError", async () => {
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { sendWhatsApp },
      bestEffort: true,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ text: "hi", mediaUrls: ["https://x.test/a.jpg"] }),
    );
  });

  it("gates outbound delivery via HITL when enabled", async () => {
    hitlMocks.createHitlRequest.mockClear();
    hitlMocks.manager.waitForDecision.mockClear();
    hitlMocks.decision = "allow-once";
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      approvals: {
        hitl: {
          enabled: true,
          apiKey: "k",
          loopId: "l",
          callbackUrl: "https://example.com/hitl/callback/secret",
          outbound: { mode: "always" },
          timeoutSeconds: 60,
          defaultDecision: "deny",
        },
      },
    };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { sendWhatsApp },
    });

    expect(hitlMocks.createHitlRequest).toHaveBeenCalledTimes(1);
    expect(hitlMocks.manager.waitForDecision).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "whatsapp", messageId: "w1", toJid: "jid" }]);
  });

  it("blocks outbound delivery when HITL denies", async () => {
    hitlMocks.decision = "deny";
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      approvals: {
        hitl: {
          enabled: true,
          apiKey: "k",
          loopId: "l",
          outbound: { mode: "always" },
          timeoutSeconds: 60,
          defaultDecision: "deny",
        },
      },
    };

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "hello" }],
        deps: { sendWhatsApp },
      }),
    ).rejects.toThrow(/blocked/i);
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("persists allow-always decisions to the HITL allowlist", async () => {
    hitlMocks.allowlist.addHitlAllowlistEntry.mockClear();
    hitlMocks.decision = "allow-always";
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      approvals: {
        hitl: {
          enabled: true,
          apiKey: "k",
          loopId: "l",
          outbound: { mode: "always" },
          timeoutSeconds: 60,
          defaultDecision: "deny",
        },
      },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { sendWhatsApp },
    });

    expect(hitlMocks.allowlist.addHitlAllowlistEntry).toHaveBeenCalledWith(
      expect.stringContaining("outbound:whatsapp:to=+1555"),
    );
  });

  it("skips HITL gating when bypassHitl is set", async () => {
    hitlMocks.createHitlRequest.mockClear();
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      approvals: {
        hitl: {
          enabled: true,
          apiKey: "k",
          loopId: "l",
          outbound: { mode: "always" },
          timeoutSeconds: 60,
          defaultDecision: "deny",
        },
      },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { sendWhatsApp },
      approval: { bypassHitl: true },
    });

    expect(hitlMocks.createHitlRequest).not.toHaveBeenCalled();
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
  });

  it("mirrors delivered output when mirror options are provided", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
    };
    mocks.appendAssistantMessageToSessionTranscript.mockClear();

    await deliverOutboundPayloads({
      cfg,
      channel: "telegram",
      to: "123",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/files/report.pdf?sig=1" }],
      deps: { sendTelegram },
      mirror: {
        sessionKey: "agent:main:main",
        text: "caption",
        mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
      },
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: "report.pdf" }),
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
