import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildForwardTarget,
  buildTopicSuffix,
  clearLastForward,
  clearRecentTweetForward,
  formatForwardAck,
  formatForwardBody,
  formatGeneralForwardBody,
  getLastForward,
  getRecentTweetForward,
  recordLastForward,
  recordRecentTweetForward,
  resolveContentForwardConfig,
  type ResolvedContentForwardConfig,
} from "./content-forward.js";

describe("resolveContentForwardConfig", () => {
  it("returns null when forward is not configured", () => {
    const cfg = { agents: { contentRouting: {} } } as OpenClawConfig;
    expect(resolveContentForwardConfig(cfg)).toBeNull();
  });

  it("returns null when forward.enabled is false", () => {
    const cfg = {
      agents: { contentRouting: { forward: { enabled: false } } },
    } as OpenClawConfig;
    expect(resolveContentForwardConfig(cfg)).toBeNull();
  });

  it("returns defaults when enabled with no overrides", () => {
    const cfg = {
      agents: { contentRouting: { forward: { enabled: true } } },
    } as OpenClawConfig;
    const result = resolveContentForwardConfig(cfg);
    expect(result).toEqual({
      enabled: true,
      channel: "zulip",
      streams: {},
      streamPattern: "{agent}",
      topicPrefix: "x",
    });
  });

  it("uses custom values when provided", () => {
    const cfg = {
      agents: {
        contentRouting: {
          forward: {
            enabled: true,
            channel: "slack",
            streams: { cody: "dev-loop" },
            streamPattern: "agent-{agent}",
            topicPrefix: "tweet",
          },
        },
      },
    } as OpenClawConfig;
    const result = resolveContentForwardConfig(cfg);
    expect(result).toEqual({
      enabled: true,
      channel: "slack",
      streams: { cody: "dev-loop" },
      streamPattern: "agent-{agent}",
      topicPrefix: "tweet",
    });
  });
});

describe("buildForwardTarget", () => {
  const defaultConfig: ResolvedContentForwardConfig = {
    enabled: true,
    channel: "zulip",
    streams: {},
    streamPattern: "{agent}",
    topicPrefix: "x",
  };

  it("produces correct stream:AGENT:topic:PREFIX: SUFFIX", () => {
    const result = buildForwardTarget({
      config: defaultConfig,
      agentId: "liev",
      topicSuffix: "best supplements for sleep",
    });
    expect(result).toEqual({
      channel: "zulip",
      to: "stream:liev:topic:x: best supplements for sleep",
    });
  });

  it("truncates topic suffix to stay within 60-char Zulip limit", () => {
    const longSuffix = "a".repeat(100);
    const result = buildForwardTarget({
      config: defaultConfig,
      agentId: "cody",
      topicSuffix: longSuffix,
    });
    // topic = "x: " + truncated suffix = 60 chars max
    const topic = result.to.replace("stream:cody:topic:", "");
    expect(topic.length).toBeLessThanOrEqual(60);
    expect(topic.startsWith("x: ")).toBe(true);
  });

  it("uses custom stream pattern", () => {
    const result = buildForwardTarget({
      config: { ...defaultConfig, streams: {}, streamPattern: "team-{agent}" },
      agentId: "finn",
      topicSuffix: "revenue report",
    });
    expect(result.to).toBe("stream:team-finn:topic:x: revenue report");
  });

  it("handles empty topic suffix gracefully", () => {
    const result = buildForwardTarget({
      config: defaultConfig,
      agentId: "liev",
      topicSuffix: "",
    });
    expect(result.to).toBe("stream:liev:topic:x");
  });

  it("uses explicit streams map over streamPattern", () => {
    const result = buildForwardTarget({
      config: {
        ...defaultConfig,
        streams: {
          liev: "08🌱 life-loop",
          cody: "04💻 coding-loop",
        },
      },
      agentId: "liev",
      topicSuffix: "supplements for sleep",
    });
    expect(result.to).toBe("stream:08🌱 life-loop:topic:x: supplements for sleep");
  });

  it("falls back to streamPattern when agent not in streams map", () => {
    const result = buildForwardTarget({
      config: {
        ...defaultConfig,
        streams: { liev: "08🌱 life-loop" },
      },
      agentId: "finn",
      topicSuffix: "revenue up",
    });
    expect(result.to).toBe("stream:finn:topic:x: revenue up");
  });
});

describe("formatForwardBody", () => {
  it("includes tweet text, URL, and stable routed target text", () => {
    const body = formatForwardBody({
      tweetText: "Best supplements for sleep",
      tweetUrl: "https://x.com/user/status/123",
      classification: {
        kind: "recognized",
        agentId: "liev",
        confidence: "high",
        reason: "LLM classified as health & wellness",
      },
    });
    expect(body).toContain("Best supplements for sleep");
    expect(body).toContain("https://x.com/user/status/123");
    expect(body).toContain("Routed to liev");
    expect(body).not.toContain("LLM classified as health & wellness");
  });

  it("includes tweet author when provided", () => {
    const body = formatForwardBody({
      tweetText: "Some tweet",
      tweetUrl: "https://x.com/user/status/123",
      tweetAuthor: "someuser",
      classification: {
        kind: "recognized",
        agentId: "cody",
        confidence: "medium",
        reason: "LLM classified as code",
      },
    });
    expect(body).toContain("**@someuser**");
  });
});

describe("formatForwardAck", () => {
  it("produces short ack string without topic", () => {
    expect(formatForwardAck({ agentId: "liev", stream: "liev" })).toBe("→ liev #liev");
  });

  it("works with different agent and stream", () => {
    expect(formatForwardAck({ agentId: "cody", stream: "team-cody" })).toBe("→ cody #team-cody");
  });

  it("includes topic on second line when provided", () => {
    expect(
      formatForwardAck({
        agentId: "liev",
        stream: "08🌱 life-loop",
        topic: "x: supplements for sleep",
      }),
    ).toBe("→ liev #08🌱 life-loop\nx: supplements for sleep");
  });

  it("includes Zulip narrow link when baseUrl provided", () => {
    const result = formatForwardAck({
      agentId: "liev",
      stream: "08🌱 life-loop",
      topic: "x: supplements for sleep",
      zulipBaseUrl: "https://zulip.example.com",
    });
    expect(result).toContain("→ liev #08🌱 life-loop");
    expect(result).toContain("x: supplements for sleep");
    expect(result).toContain("https://zulip.example.com/#narrow/stream/");
    expect(result).toContain("/topic/");
  });

  it("prefers a message permalink when Zulip message id is available", () => {
    const result = formatForwardAck({
      agentId: "finn",
      stream: "12💰 finn-loop",
      topic: "x: save 74% on anthropic",
      zulipBaseUrl: "https://zulip.example.com",
      zulipMessageId: "3447",
    });
    expect(result).toContain("→ finn #12💰 finn-loop");
    expect(result).toContain("x: save 74% on anthropic");
    expect(result).toContain("https://zulip.example.com/#narrow/near/3447");
    expect(result).not.toContain("/stream/");
    expect(result).not.toContain("/topic/");
  });

  it("includes link without topic", () => {
    const result = formatForwardAck({
      agentId: "cody",
      stream: "cody",
      zulipBaseUrl: "https://zulip.example.com/",
    });
    expect(result).toBe("→ cody #cody\nhttps://zulip.example.com/#narrow/stream/cody");
  });

  it("omits link when no baseUrl", () => {
    const result = formatForwardAck({
      agentId: "liev",
      stream: "liev",
      topic: "some topic",
    });
    expect(result).not.toContain("http");
  });
});

describe("follow-up tracking", () => {
  const peer = "test-peer";
  const tweetId = "2029856270271008942";

  afterEach(async () => {
    clearLastForward(peer);
    await clearRecentTweetForward(peer, tweetId);
  });

  it("returns null when no forward recorded", () => {
    expect(getLastForward(peer)).toBeNull();
  });

  it("returns entry within TTL window", () => {
    const entry = {
      channel: "zulip",
      to: "stream:liev:topic:x: sleep tips",
      agentId: "liev",
      stream: "08🌱 life-loop",
      tweetText: "sleep tips",
      timestamp: Date.now(),
    };
    recordLastForward(peer, entry);
    expect(getLastForward(peer)).toEqual(entry);
  });

  it("returns null after TTL expires", () => {
    recordLastForward(peer, {
      channel: "zulip",
      to: "stream:liev:topic:x: old",
      agentId: "liev",
      stream: "liev",
      tweetText: "old",
      timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    });
    expect(getLastForward(peer)).toBeNull();
  });

  it("clearLastForward removes entry", () => {
    recordLastForward(peer, {
      channel: "zulip",
      to: "stream:cody:topic:x: rust",
      agentId: "cody",
      stream: "cody",
      tweetText: "rust",
      timestamp: Date.now(),
    });
    clearLastForward(peer);
    expect(getLastForward(peer)).toBeNull();
  });

  it("returns recent tweet forward entries by sender + tweet id", async () => {
    const entry = {
      channel: "zulip",
      to: "stream:04💻 coding-loop:topic:x: @aiwithjainam (Jainam Parmar):🚨 This m",
      agentId: "cody",
      stream: "04💻 coding-loop",
      messageId: "3382",
      tweetId,
      timestamp: Date.now(),
    };
    await recordRecentTweetForward(peer, tweetId, entry);
    expect(await getRecentTweetForward(peer, tweetId)).toEqual(entry);
  });

  it("expires recent tweet forward entries after TTL", async () => {
    await recordRecentTweetForward(peer, tweetId, {
      channel: "zulip",
      to: "stream:04💻 coding-loop:topic:x: stale",
      agentId: "cody",
      stream: "04💻 coding-loop",
      messageId: "3382",
      tweetId,
      timestamp: Date.now() - 25 * 60 * 60 * 1000,
    });
    expect(await getRecentTweetForward(peer, tweetId)).toBeNull();
  });

  it("loads recent tweet forwards from disk after module reload", async () => {
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-forward-dedupe-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    try {
      vi.resetModules();
      const firstLoad = await import("./content-forward.js");
      const entry = {
        channel: "zulip",
        to: "stream:04💻 coding-loop:topic:x: reuse this thread",
        agentId: "cody",
        stream: "04💻 coding-loop",
        messageId: "3382",
        tweetId,
        timestamp: Date.now(),
      };
      await firstLoad.recordRecentTweetForward(peer, tweetId, entry);

      vi.resetModules();
      const secondLoad = await import("./content-forward.js");
      expect(await secondLoad.getRecentTweetForward(peer, tweetId)).toEqual(entry);
      await secondLoad.clearRecentTweetForward(peer, tweetId);
    } finally {
      if (previousStateDir) {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
      await fs.rm(tempStateDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});

describe("buildForwardTarget with category", () => {
  const configWithCategories: ResolvedContentForwardConfig = {
    enabled: true,
    channel: "zulip",
    streams: {
      liev: "08🌱 life-loop",
      "liev:intake": "08🌱 intake-tracker",
      "liev:fitness": "08🌱 fitness-exercise",
      cody: "04💻 coding-loop",
    },
    streamPattern: "{agent}",
    topicPrefix: "x",
  };

  it("uses agent:category stream when category matches", () => {
    const result = buildForwardTarget({
      config: configWithCategories,
      agentId: "liev",
      category: "intake",
      topicSuffix: "breakfast",
    });
    expect(result.to).toBe("stream:08🌱 intake-tracker:topic:x: breakfast");
  });

  it("falls back to agent stream when category not in map", () => {
    const result = buildForwardTarget({
      config: configWithCategories,
      agentId: "liev",
      category: "unknown",
      topicSuffix: "something",
    });
    expect(result.to).toBe("stream:08🌱 life-loop:topic:x: something");
  });

  it("falls back to agent stream when no category provided", () => {
    const result = buildForwardTarget({
      config: configWithCategories,
      agentId: "liev",
      topicSuffix: "general content",
    });
    expect(result.to).toBe("stream:08🌱 life-loop:topic:x: general content");
  });

  it("uses custom topicPrefix override", () => {
    const result = buildForwardTarget({
      config: configWithCategories,
      agentId: "liev",
      category: "intake",
      topicSuffix: "lunch",
      topicPrefix: "photo",
    });
    expect(result.to).toBe("stream:08🌱 intake-tracker:topic:photo: lunch");
  });
});

describe("buildTopicSuffix", () => {
  it("returns text summary for plain text", () => {
    const result = buildTopicSuffix({ text: "had a great run today 5k in 22min" });
    expect(result.suffix).toBe("had a great run today 5k in 22min");
    expect(result.prefix).toBeUndefined();
  });

  it("returns domain for URL content", () => {
    const result = buildTopicSuffix({ text: "https://github.com/foo/bar check this out" });
    expect(result.suffix).toBe("check this out");
    expect(result.prefix).toBe("link");
  });

  it("returns domain when URL is the only content", () => {
    const result = buildTopicSuffix({ text: "https://github.com/foo/bar" });
    expect(result.suffix).toBe("github.com");
    expect(result.prefix).toBe("link");
  });

  it("returns photo prefix for media-only messages", () => {
    const result = buildTopicSuffix({ text: "<media:image>", mediaType: "image/jpeg" });
    expect(result.prefix).toBe("photo");
    expect(result.suffix).toMatch(/\d{2}-\d{2}/); // MM-DD format
  });

  it("returns tweet text directly when provided", () => {
    const result = buildTopicSuffix({
      text: "https://x.com/user/status/123",
      tweetText: "Best supplements for sleep",
    });
    expect(result.suffix).toBe("Best supplements for sleep");
    expect(result.prefix).toBeUndefined();
  });

  it("prefers the user note over raw tweet text for X-link topics", () => {
    const result = buildTopicSuffix({
      text: "https://x.com/user/status/123 Did we implement this into our setup?",
      tweetText: "@user (User): Built an autonomous agent team that runs 24/7",
    });
    expect(result.suffix).toBe("Did we implement this into our setup?");
  });

  it("strips author prefixes from tweet-derived topic suffixes", () => {
    const result = buildTopicSuffix({
      text: "https://x.com/user/status/123",
      tweetText: "@aiwithjainam (Jainam Parmar): 🚨 This memory system keeps context forever",
    });
    expect(result.suffix).toBe("🚨 This memory system keeps context forever");
  });

  it("truncates long text to 50 chars", () => {
    const longText = "a".repeat(80);
    const result = buildTopicSuffix({ text: longText });
    expect(result.suffix.length).toBe(50);
  });
});

describe("formatGeneralForwardBody", () => {
  it("formats text-only content", () => {
    const body = formatGeneralForwardBody({
      text: "had a great run today",
      classification: {
        kind: "recognized",
        agentId: "liev",
        confidence: "high",
        reason: "LLM classified as health",
      },
    });
    expect(body).toContain("had a great run today");
    expect(body).toContain("Routed to liev");
    expect(body).not.toContain("LLM classified as health");
  });

  it("includes media type when present", () => {
    const body = formatGeneralForwardBody({
      text: "<media:image>",
      mediaType: "image/jpeg",
      classification: {
        kind: "recognized",
        agentId: "liev",
        confidence: "high",
        reason: "LLM classified as intake",
      },
    });
    expect(body).toContain("image/jpeg");
  });
});
