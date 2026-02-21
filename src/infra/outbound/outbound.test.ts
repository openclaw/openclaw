import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../../extensions/telegram/src/channel.js";
import { whatsappPlugin } from "../../../extensions/whatsapp/src/channel.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  ackDelivery,
  computeBackoffMs,
  type DeliverFn,
  enqueueDelivery,
  failDelivery,
  loadPendingDeliveries,
  MAX_RETRIES,
  moveToFailed,
  recoverPendingDeliveries,
} from "./delivery-queue.js";
import { DirectoryCache } from "./directory-cache.js";
import { buildOutboundResultEnvelope } from "./envelope.js";
import type { OutboundDeliveryJson } from "./format.js";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "./format.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  enforceCrossContextPolicy,
} from "./outbound-policy.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";
import {
  formatOutboundPayloadLog,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
} from "./payloads.js";
import { resolveOutboundTarget } from "./targets.js";

describe("delivery-queue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dq-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("enqueue + ack lifecycle", () => {
    it("creates and removes a queue entry", async () => {
      const id = await enqueueDelivery(
        {
          channel: "whatsapp",
          to: "+1555",
          payloads: [{ text: "hello" }],
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          mirror: {
            sessionKey: "agent:main:main",
            text: "hello",
            mediaUrls: ["https://example.com/file.png"],
          },
        },
        tmpDir,
      );

      // Entry file exists after enqueue.
      const queueDir = path.join(tmpDir, "delivery-queue");
      const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toBe(`${id}.json`);

      // Entry contents are correct.
      const entry = JSON.parse(fs.readFileSync(path.join(queueDir, files[0]), "utf-8"));
      expect(entry).toMatchObject({
        id,
        channel: "whatsapp",
        to: "+1555",
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        mirror: {
          sessionKey: "agent:main:main",
          text: "hello",
          mediaUrls: ["https://example.com/file.png"],
        },
        retryCount: 0,
      });
      expect(entry.payloads).toEqual([{ text: "hello" }]);

      // Ack removes the file.
      await ackDelivery(id, tmpDir);
      const remaining = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
      expect(remaining).toHaveLength(0);
    });

    it("ack is idempotent (no error on missing file)", async () => {
      await expect(ackDelivery("nonexistent-id", tmpDir)).resolves.toBeUndefined();
    });
  });

  describe("failDelivery", () => {
    it("increments retryCount and sets lastError", async () => {
      const id = await enqueueDelivery(
        {
          channel: "telegram",
          to: "123",
          payloads: [{ text: "test" }],
        },
        tmpDir,
      );

      await failDelivery(id, "connection refused", tmpDir);

      const queueDir = path.join(tmpDir, "delivery-queue");
      const entry = JSON.parse(fs.readFileSync(path.join(queueDir, `${id}.json`), "utf-8"));
      expect(entry.retryCount).toBe(1);
      expect(entry.lastError).toBe("connection refused");
    });
  });

  describe("moveToFailed", () => {
    it("moves entry to failed/ subdirectory", async () => {
      const id = await enqueueDelivery(
        {
          channel: "slack",
          to: "#general",
          payloads: [{ text: "hi" }],
        },
        tmpDir,
      );

      await moveToFailed(id, tmpDir);

      const queueDir = path.join(tmpDir, "delivery-queue");
      const failedDir = path.join(queueDir, "failed");
      expect(fs.existsSync(path.join(queueDir, `${id}.json`))).toBe(false);
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
    });
  });

  describe("loadPendingDeliveries", () => {
    it("returns empty array when queue directory does not exist", async () => {
      const nonexistent = path.join(tmpDir, "no-such-dir");
      const entries = await loadPendingDeliveries(nonexistent);
      expect(entries).toEqual([]);
    });

    it("loads multiple entries", async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);
      await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir);

      const entries = await loadPendingDeliveries(tmpDir);
      expect(entries).toHaveLength(2);
    });
  });

  describe("computeBackoffMs", () => {
    it("returns scheduled backoff values and clamps at max retry", () => {
      const cases = [
        { retryCount: 0, expected: 0 },
        { retryCount: 1, expected: 5_000 },
        { retryCount: 2, expected: 25_000 },
        { retryCount: 3, expected: 120_000 },
        { retryCount: 4, expected: 600_000 },
        // Beyond defined schedule -- clamps to last value.
        { retryCount: 5, expected: 600_000 },
      ] as const;

      for (const testCase of cases) {
        expect(computeBackoffMs(testCase.retryCount), String(testCase.retryCount)).toBe(
          testCase.expected,
        );
      }
    });
  });

  describe("recoverPendingDeliveries", () => {
    const noopDelay = async () => {};
    const baseCfg = {};
    const createLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const enqueueCrashRecoveryEntries = async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);
      await enqueueDelivery({ channel: "telegram", to: "2", payloads: [{ text: "b" }] }, tmpDir);
    };
    const runRecovery = async ({
      deliver,
      log = createLog(),
      delay = noopDelay,
      maxRecoveryMs,
    }: {
      deliver: ReturnType<typeof vi.fn>;
      log?: ReturnType<typeof createLog>;
      delay?: (ms: number) => Promise<void>;
      maxRecoveryMs?: number;
    }) => {
      const result = await recoverPendingDeliveries({
        deliver: deliver as DeliverFn,
        log,
        cfg: baseCfg,
        stateDir: tmpDir,
        delay,
        ...(maxRecoveryMs === undefined ? {} : { maxRecoveryMs }),
      });
      return { result, log };
    };

    it("recovers entries from a simulated crash", async () => {
      // Manually create queue entries as if gateway crashed before delivery.
      await enqueueCrashRecoveryEntries();
      const deliver = vi.fn().mockResolvedValue([]);
      const { result } = await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(result.recovered).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // Queue should be empty after recovery.
      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(0);
    });

    it("moves entries that exceeded max retries to failed/", async () => {
      // Create an entry and manually set retryCount to MAX_RETRIES.
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
        tmpDir,
      );
      const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.retryCount = MAX_RETRIES;
      fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");

      const deliver = vi.fn();
      const { result } = await runRecovery({ deliver });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.skipped).toBe(1);

      // Entry should be in failed/ directory.
      const failedDir = path.join(tmpDir, "delivery-queue", "failed");
      expect(fs.existsSync(path.join(failedDir, `${id}.json`))).toBe(true);
    });

    it("increments retryCount on failed recovery attempt", async () => {
      await enqueueDelivery({ channel: "slack", to: "#ch", payloads: [{ text: "x" }] }, tmpDir);

      const deliver = vi.fn().mockRejectedValue(new Error("network down"));
      const { result } = await runRecovery({ deliver });

      expect(result.failed).toBe(1);
      expect(result.recovered).toBe(0);

      // Entry should still be in queue with incremented retryCount.
      const entries = await loadPendingDeliveries(tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].retryCount).toBe(1);
      expect(entries[0].lastError).toBe("network down");
    });

    it("passes skipQueue: true to prevent re-enqueueing during recovery", async () => {
      await enqueueDelivery({ channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] }, tmpDir);

      const deliver = vi.fn().mockResolvedValue([]);
      await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ skipQueue: true }));
    });

    it("replays stored delivery options during recovery", async () => {
      await enqueueDelivery(
        {
          channel: "whatsapp",
          to: "+1",
          payloads: [{ text: "a" }],
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          mirror: {
            sessionKey: "agent:main:main",
            text: "a",
            mediaUrls: ["https://example.com/a.png"],
          },
        },
        tmpDir,
      );

      const deliver = vi.fn().mockResolvedValue([]);
      await runRecovery({ deliver });

      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          bestEffort: true,
          gifPlayback: true,
          silent: true,
          mirror: {
            sessionKey: "agent:main:main",
            text: "a",
            mediaUrls: ["https://example.com/a.png"],
          },
        }),
      );
    });

    it("respects maxRecoveryMs time budget", async () => {
      await enqueueCrashRecoveryEntries();
      await enqueueDelivery({ channel: "slack", to: "#c", payloads: [{ text: "c" }] }, tmpDir);

      const deliver = vi.fn().mockResolvedValue([]);
      const { result, log } = await runRecovery({
        deliver,
        maxRecoveryMs: 0, // Immediate timeout -- no entries should be processed.
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(result.recovered).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // All entries should still be in the queue.
      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(3);

      // Should have logged a warning about deferred entries.
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next restart"));
    });

    it("defers entries when backoff exceeds the recovery budget", async () => {
      const id = await enqueueDelivery(
        { channel: "whatsapp", to: "+1", payloads: [{ text: "a" }] },
        tmpDir,
      );
      const filePath = path.join(tmpDir, "delivery-queue", `${id}.json`);
      const entry = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      entry.retryCount = 3;
      fs.writeFileSync(filePath, JSON.stringify(entry), "utf-8");

      const deliver = vi.fn().mockResolvedValue([]);
      const delay = vi.fn(async () => {});
      const { result, log } = await runRecovery({
        deliver,
        delay,
        maxRecoveryMs: 1000,
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(delay).not.toHaveBeenCalled();
      expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });

      const remaining = await loadPendingDeliveries(tmpDir);
      expect(remaining).toHaveLength(1);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred to next restart"));
    });

    it("returns zeros when queue is empty", async () => {
      const deliver = vi.fn();
      const { result } = await runRecovery({ deliver });

      expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0 });
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});

describe("DirectoryCache", () => {
  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires entries after ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = new DirectoryCache<string>(1000, 10);

    cache.set("a", "value-a", cfg);
    expect(cache.get("a", cfg)).toBe("value-a");

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(cache.get("a", cfg)).toBeUndefined();
  });

  it("evicts least-recent entries when capacity is exceeded", () => {
    const cases = [
      {
        actions: [
          ["set", "a", "value-a"],
          ["set", "b", "value-b"],
          ["set", "c", "value-c"],
        ] as const,
        expected: { a: undefined, b: "value-b", c: "value-c" },
      },
      {
        actions: [
          ["set", "a", "value-a"],
          ["set", "b", "value-b"],
          ["set", "a", "value-a2"],
          ["set", "c", "value-c"],
        ] as const,
        expected: { a: "value-a2", b: undefined, c: "value-c" },
      },
    ] as const;

    for (const testCase of cases) {
      const cache = new DirectoryCache<string>(60_000, 2);
      for (const action of testCase.actions) {
        cache.set(action[1], action[2], cfg);
      }
      expect(cache.get("a", cfg)).toBe(testCase.expected.a);
      expect(cache.get("b", cfg)).toBe(testCase.expected.b);
      expect(cache.get("c", cfg)).toBe(testCase.expected.c);
    }
  });
});

describe("buildOutboundResultEnvelope", () => {
  it("flattens delivery-only payloads by default", () => {
    const delivery: OutboundDeliveryJson = {
      channel: "whatsapp",
      via: "gateway",
      to: "+1",
      messageId: "m1",
      mediaUrl: null,
    };
    expect(buildOutboundResultEnvelope({ delivery })).toEqual(delivery);
  });

  it("keeps payloads and meta in the envelope", () => {
    const envelope = buildOutboundResultEnvelope({
      payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
      meta: { foo: "bar" },
    });
    expect(envelope).toEqual({
      payloads: [{ text: "hi", mediaUrl: null, mediaUrls: undefined }],
      meta: { foo: "bar" },
    });
  });

  it("includes delivery when payloads are present", () => {
    const delivery: OutboundDeliveryJson = {
      channel: "telegram",
      via: "direct",
      to: "123",
      messageId: "m2",
      mediaUrl: null,
      chatId: "c1",
    };
    const envelope = buildOutboundResultEnvelope({
      payloads: [],
      delivery,
      meta: { ok: true },
    });
    expect(envelope).toEqual({
      payloads: [],
      meta: { ok: true },
      delivery,
    });
  });

  it("can keep delivery wrapped when requested", () => {
    const delivery: OutboundDeliveryJson = {
      channel: "discord",
      via: "gateway",
      to: "channel:C1",
      messageId: "m3",
      mediaUrl: null,
      channelId: "C1",
    };
    const envelope = buildOutboundResultEnvelope({
      delivery,
      flattenDelivery: false,
    });
    expect(envelope).toEqual({ delivery });
  });
});

describe("formatOutboundDeliverySummary", () => {
  it("formats fallback and channel-specific detail variants", () => {
    const cases = [
      {
        name: "fallback telegram",
        channel: "telegram" as const,
        result: undefined,
        expected: "✅ Sent via Telegram. Message ID: unknown",
      },
      {
        name: "fallback imessage",
        channel: "imessage" as const,
        result: undefined,
        expected: "✅ Sent via iMessage. Message ID: unknown",
      },
      {
        name: "telegram with chat detail",
        channel: "telegram" as const,
        result: {
          channel: "telegram" as const,
          messageId: "m1",
          chatId: "c1",
        },
        expected: "✅ Sent via Telegram. Message ID: m1 (chat c1)",
      },
      {
        name: "discord with channel detail",
        channel: "discord" as const,
        result: {
          channel: "discord" as const,
          messageId: "d1",
          channelId: "chan",
        },
        expected: "✅ Sent via Discord. Message ID: d1 (channel chan)",
      },
    ] as const;

    for (const testCase of cases) {
      expect(formatOutboundDeliverySummary(testCase.channel, testCase.result), testCase.name).toBe(
        testCase.expected,
      );
    }
  });
});

describe("buildOutboundDeliveryJson", () => {
  it("builds direct delivery payloads across provider-specific fields", () => {
    const cases = [
      {
        name: "telegram direct payload",
        input: {
          channel: "telegram" as const,
          to: "123",
          result: { channel: "telegram" as const, messageId: "m1", chatId: "c1" },
          mediaUrl: "https://example.com/a.png",
        },
        expected: {
          channel: "telegram",
          via: "direct",
          to: "123",
          messageId: "m1",
          mediaUrl: "https://example.com/a.png",
          chatId: "c1",
        },
      },
      {
        name: "whatsapp metadata",
        input: {
          channel: "whatsapp" as const,
          to: "+1",
          result: { channel: "whatsapp" as const, messageId: "w1", toJid: "jid" },
        },
        expected: {
          channel: "whatsapp",
          via: "direct",
          to: "+1",
          messageId: "w1",
          mediaUrl: null,
          toJid: "jid",
        },
      },
      {
        name: "signal timestamp",
        input: {
          channel: "signal" as const,
          to: "+1",
          result: { channel: "signal" as const, messageId: "s1", timestamp: 123 },
        },
        expected: {
          channel: "signal",
          via: "direct",
          to: "+1",
          messageId: "s1",
          mediaUrl: null,
          timestamp: 123,
        },
      },
    ] as const;

    for (const testCase of cases) {
      expect(buildOutboundDeliveryJson(testCase.input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("formatGatewaySummary", () => {
  it("formats default and custom gateway action summaries", () => {
    const cases = [
      {
        name: "default send action",
        input: { channel: "whatsapp", messageId: "m1" },
        expected: "✅ Sent via gateway (whatsapp). Message ID: m1",
      },
      {
        name: "custom action",
        input: { action: "Poll sent", channel: "discord", messageId: "p1" },
        expected: "✅ Poll sent via gateway (discord). Message ID: p1",
      },
    ] as const;

    for (const testCase of cases) {
      expect(formatGatewaySummary(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

const slackConfig = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

const discordConfig = {
  channels: {
    discord: {},
  },
} as OpenClawConfig;

describe("outbound policy", () => {
  it("allows cross-provider sends when enabled", () => {
    const cfg = {
      ...slackConfig,
      tools: {
        message: { crossContext: { allowAcrossProviders: true } },
      },
    } as OpenClawConfig;

    expect(() =>
      enforceCrossContextPolicy({
        cfg,
        channel: "telegram",
        action: "send",
        args: { to: "telegram:@ops" },
        toolContext: { currentChannelId: "C12345678", currentChannelProvider: "slack" },
      }),
    ).not.toThrow();
  });

  it("uses components when available and preferred", async () => {
    const decoration = await buildCrossContextDecoration({
      cfg: discordConfig,
      channel: "discord",
      target: "123",
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "discord" },
    });

    expect(decoration).not.toBeNull();
    const applied = applyCrossContextDecoration({
      message: "hello",
      decoration: decoration!,
      preferComponents: true,
    });

    expect(applied.usedComponents).toBe(true);
    expect(applied.componentsBuilder).toBeDefined();
    expect(applied.componentsBuilder?.("hello").length).toBeGreaterThan(0);
    expect(applied.message).toBe("hello");
  });
});

describe("resolveOutboundSessionRoute", () => {
  const baseConfig = {} as OpenClawConfig;

  it("builds Slack thread session keys", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: baseConfig,
      channel: "slack",
      agentId: "main",
      target: "channel:C123",
      replyToId: "456",
    });

    expect(route?.sessionKey).toBe("agent:main:slack:channel:c123:thread:456");
    expect(route?.from).toBe("slack:channel:C123");
    expect(route?.to).toBe("channel:C123");
    expect(route?.threadId).toBe("456");
  });

  it("uses Telegram topic ids in group session keys", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: baseConfig,
      channel: "telegram",
      agentId: "main",
      target: "-100123456:topic:42",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:group:-100123456:topic:42");
    expect(route?.from).toBe("telegram:group:-100123456:topic:42");
    expect(route?.to).toBe("telegram:-100123456");
    expect(route?.threadId).toBe(42);
  });

  it("treats Telegram usernames as DMs when unresolved", async () => {
    const cfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;
    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "telegram",
      agentId: "main",
      target: "@alice",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:direct:@alice");
    expect(route?.chatType).toBe("direct");
  });

  it("honors dmScope identity links", async () => {
    const cfg = {
      session: {
        dmScope: "per-peer",
        identityLinks: {
          alice: ["discord:123"],
        },
      },
    } as OpenClawConfig;

    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "discord",
      agentId: "main",
      target: "user:123",
    });

    expect(route?.sessionKey).toBe("agent:main:direct:alice");
  });

  it("strips chat_* prefixes for BlueBubbles group session keys", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: baseConfig,
      channel: "bluebubbles",
      agentId: "main",
      target: "chat_guid:ABC123",
    });

    expect(route?.sessionKey).toBe("agent:main:bluebubbles:group:abc123");
    expect(route?.from).toBe("group:ABC123");
  });

  it("treats Zalo Personal DM targets as direct sessions", async () => {
    const cfg = { session: { dmScope: "per-channel-peer" } } as OpenClawConfig;
    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "zalouser",
      agentId: "main",
      target: "123456",
    });

    expect(route?.sessionKey).toBe("agent:main:zalouser:direct:123456");
    expect(route?.chatType).toBe("direct");
  });

  it("uses group session keys for Slack mpim allowlist entries", async () => {
    const cfg = {
      channels: {
        slack: {
          dm: {
            groupChannels: ["G123"],
          },
        },
      },
    } as OpenClawConfig;

    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "slack",
      agentId: "main",
      target: "channel:G123",
    });

    expect(route?.sessionKey).toBe("agent:main:slack:group:g123");
    expect(route?.from).toBe("slack:group:G123");
  });
});

describe("normalizeOutboundPayloadsForJson", () => {
  it("normalizes payloads for JSON output", () => {
    const cases = [
      {
        input: [
          { text: "hi" },
          { text: "photo", mediaUrl: "https://x.test/a.jpg" },
          { text: "multi", mediaUrls: ["https://x.test/1.png"] },
        ],
        expected: [
          { text: "hi", mediaUrl: null, mediaUrls: undefined, channelData: undefined },
          {
            text: "photo",
            mediaUrl: "https://x.test/a.jpg",
            mediaUrls: ["https://x.test/a.jpg"],
            channelData: undefined,
          },
          {
            text: "multi",
            mediaUrl: null,
            mediaUrls: ["https://x.test/1.png"],
            channelData: undefined,
          },
        ],
      },
      {
        input: [
          {
            text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
          },
        ],
        expected: [
          {
            text: "",
            mediaUrl: null,
            mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
            channelData: undefined,
          },
        ],
      },
    ] as const;

    for (const testCase of cases) {
      expect(normalizeOutboundPayloadsForJson(testCase.input)).toEqual(testCase.expected);
    }
  });
});

describe("normalizeOutboundPayloads", () => {
  it("keeps channelData-only payloads", () => {
    const channelData = { line: { flexMessage: { altText: "Card", contents: {} } } };
    const normalized = normalizeOutboundPayloads([{ channelData }]);
    expect(normalized).toEqual([{ text: "", mediaUrls: [], channelData }]);
  });
});

describe("formatOutboundPayloadLog", () => {
  it("formats text+media and media-only logs", () => {
    const cases = [
      {
        name: "text with media lines",
        input: {
          text: "hello  ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        },
        expected: "hello\nMEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
      },
      {
        name: "media only",
        input: {
          text: "",
          mediaUrls: ["https://x.test/a.png"],
        },
        expected: "MEDIA:https://x.test/a.png",
      },
    ] as const;

    for (const testCase of cases) {
      expect(formatOutboundPayloadLog(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("resolveOutboundTarget", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
        { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    {
      name: "normalizes whatsapp target when provided",
      input: { channel: "whatsapp" as const, to: " (555) 123-4567 " },
      expected: { ok: true as const, to: "+5551234567" },
    },
    {
      name: "keeps whatsapp group targets",
      input: { channel: "whatsapp" as const, to: "120363401234567890@g.us" },
      expected: { ok: true as const, to: "120363401234567890@g.us" },
    },
    {
      name: "normalizes prefixed/uppercase whatsapp group targets",
      input: {
        channel: "whatsapp" as const,
        to: " WhatsApp:120363401234567890@G.US ",
      },
      expected: { ok: true as const, to: "120363401234567890@g.us" },
    },
    {
      name: "rejects whatsapp with empty target in explicit mode even with cfg allowFrom",
      input: {
        channel: "whatsapp" as const,
        to: "",
        cfg: { channels: { whatsapp: { allowFrom: ["+1555"] } } } as OpenClawConfig,
        mode: "explicit" as const,
      },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects whatsapp with empty target and allowFrom (no silent fallback)",
      input: { channel: "whatsapp" as const, to: "", allowFrom: ["+1555"] },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects whatsapp with empty target and prefixed allowFrom (no silent fallback)",
      input: {
        channel: "whatsapp" as const,
        to: "",
        allowFrom: ["whatsapp:(555) 123-4567"],
      },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects invalid whatsapp target",
      input: { channel: "whatsapp" as const, to: "wat" },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects whatsapp without to when allowFrom missing",
      input: { channel: "whatsapp" as const, to: " " },
      expectedErrorIncludes: "WhatsApp",
    },
    {
      name: "rejects whatsapp allowFrom fallback when invalid",
      input: { channel: "whatsapp" as const, to: "", allowFrom: ["wat"] },
      expectedErrorIncludes: "WhatsApp",
    },
  ])("$name", ({ input, expected, expectedErrorIncludes }) => {
    const res = resolveOutboundTarget(input);
    if (expected) {
      expect(res).toEqual(expected);
      return;
    }
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain(expectedErrorIncludes);
    }
  });

  it("rejects invalid non-whatsapp targets", () => {
    const cases = [
      { input: { channel: "telegram" as const, to: " " }, expectedErrorIncludes: "Telegram" },
      { input: { channel: "webchat" as const, to: "x" }, expectedErrorIncludes: "WebChat" },
    ] as const;

    for (const testCase of cases) {
      const res = resolveOutboundTarget(testCase.input);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.message).toContain(testCase.expectedErrorIncludes);
      }
    }
  });
});
