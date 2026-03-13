/**
 * Integration tests for the iMessage → Zulip general intake pipe.
 *
 * Tests the full flow: classify → build target → format → ack,
 * verifying that all content types route correctly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildForwardTarget,
  buildTopicSuffix,
  formatForwardAck,
  formatGeneralForwardBody,
  resolveContentForwardConfig,
  type ResolvedContentForwardConfig,
} from "./content-forward.js";
import {
  classifyContentWithLLM,
  parseAgentCategory,
  resolveContentRouteFastPath,
  resolveContentRoutingConfig,
} from "./content-route.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const AGENT_DESCRIPTIONS: Record<string, string> = {
  liev: "health, wellness, supplements, biohacking, food, meals, nutrition, exercise, fitness. Categories: intake (food/meals), fitness (exercise), health (general)",
  cody: "programming, code, dev tools, GitHub. Categories: review (code review), debug (troubleshooting)",
  finn: "finance, expenses, budgets, invoices, payments",
  main: "general conversation, anything else",
};

const forwardConfig: ResolvedContentForwardConfig = {
  enabled: true,
  channel: "zulip",
  streams: {
    liev: "08🌱 life-loop",
    "liev:intake": "08🌱 intake-tracker",
    "liev:fitness": "08🌱 fitness-exercise",
    cody: "04💻 coding-loop",
    finn: "12💰 finn-loop",
  },
  streamPattern: "{agent}",
  topicPrefix: "x",
};

// --- Scenario tests matching the plan's walkthrough table ---

describe("intake pipe: scenario walkthrough", () => {
  it("scenario 1: tweet URL → routes to agent stream with x: prefix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "liev:health" } }),
      }),
    );

    const classification = await classifyContentWithLLM({
      text: "https://x.com/user/status/123",
      tweetText: "Best supplements for sleep",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(classification.kind).toBe("recognized");
    if (classification.kind !== "recognized") {
      throw new Error("expected recognized classification");
    }
    expect(classification.agentId).toBe("liev");
    expect(classification.category).toBe("health");

    const topicInfo = buildTopicSuffix({
      text: "https://x.com/user/status/123",
      tweetText: "Best supplements for sleep",
    });
    expect(topicInfo.suffix).toBe("Best supplements for sleep");

    const target = buildForwardTarget({
      config: forwardConfig,
      agentId: classification.agentId,
      category: classification.category,
      topicSuffix: topicInfo.suffix.slice(0, 40),
      topicPrefix: topicInfo.prefix,
    });

    // health category has no specific stream, falls back to liev default
    expect(target.to).toBe("stream:08🌱 life-loop:topic:x: Best supplements for sleep");
    expect(target.channel).toBe("zulip");
  });

  it("scenario 2: breakfast photo → intake-tracker stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "liev:intake" } }),
      }),
    );

    const classification = await classifyContentWithLLM({
      text: "<media:image>",
      mediaType: "image/jpeg",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(classification.kind).toBe("recognized");
    if (classification.kind !== "recognized") {
      throw new Error("expected recognized classification");
    }
    expect(classification.agentId).toBe("liev");
    expect(classification.category).toBe("intake");

    const topicInfo = buildTopicSuffix({
      text: "<media:image>",
      mediaType: "image/jpeg",
    });
    expect(topicInfo.prefix).toBe("photo");

    const target = buildForwardTarget({
      config: forwardConfig,
      agentId: "liev",
      category: "intake",
      topicSuffix: topicInfo.suffix,
      topicPrefix: topicInfo.prefix,
    });

    // intake category → intake-tracker stream
    expect(target.to).toMatch(/^stream:08🌱 intake-tracker:topic:photo: \d{2}-\d{2}$/);
  });

  it("scenario 3: text question → intake-tracker stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "liev:intake" } }),
      }),
    );

    const classification = await classifyContentWithLLM({
      text: "what's my macro split this week?",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(classification.kind).toBe("recognized");
    if (classification.kind !== "recognized") {
      throw new Error("expected recognized classification");
    }
    expect(classification.agentId).toBe("liev");
    expect(classification.category).toBe("intake");

    const topicInfo = buildTopicSuffix({ text: "what's my macro split this week?" });
    expect(topicInfo.suffix).toBe("what's my macro split this week?");
    expect(topicInfo.prefix).toBeUndefined();

    const target = buildForwardTarget({
      config: forwardConfig,
      agentId: "liev",
      category: "intake",
      topicSuffix: topicInfo.suffix.slice(0, 40),
    });

    expect(target.to).toBe("stream:08🌱 intake-tracker:topic:x: what's my macro split this week?");
  });

  it("scenario 4: GitHub link → coding-loop stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "cody" } }),
      }),
    );

    const classification = await classifyContentWithLLM({
      text: "https://github.com/foo/bar",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(classification.kind).toBe("recognized");
    if (classification.kind !== "recognized") {
      throw new Error("expected recognized classification");
    }
    expect(classification.agentId).toBe("cody");
    expect(classification.category).toBeUndefined();

    const topicInfo = buildTopicSuffix({ text: "https://github.com/foo/bar" });
    expect(topicInfo.prefix).toBe("link");
    expect(topicInfo.suffix).toBe("github.com");

    const target = buildForwardTarget({
      config: forwardConfig,
      agentId: "cody",
      topicSuffix: topicInfo.suffix,
      topicPrefix: topicInfo.prefix,
    });

    expect(target.to).toBe("stream:04💻 coding-loop:topic:link: github.com");
  });

  it("scenario 5: exercise text → fitness-exercise stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "liev:fitness" } }),
      }),
    );

    const classification = await classifyContentWithLLM({
      text: "had a great run today 5k in 22min",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(classification.kind).toBe("recognized");
    if (classification.kind !== "recognized") {
      throw new Error("expected recognized classification");
    }
    expect(classification.agentId).toBe("liev");
    expect(classification.category).toBe("fitness");

    const target = buildForwardTarget({
      config: forwardConfig,
      agentId: "liev",
      category: "fitness",
      topicSuffix: "had a great run today 5k in 22min",
    });

    expect(target.to).toBe(
      "stream:08🌱 fitness-exercise:topic:x: had a great run today 5k in 22min",
    );
  });
});

describe("intake pipe: ack formatting", () => {
  it("formats ack with agent and stream name", () => {
    expect(formatForwardAck({ agentId: "liev", stream: "08🌱 intake-tracker" })).toBe(
      "→ liev #08🌱 intake-tracker",
    );
  });

  it("formats ack with topic on second line", () => {
    expect(
      formatForwardAck({
        agentId: "liev",
        stream: "08🌱 intake-tracker",
        topic: "x: what's my macro split this week?",
      }),
    ).toBe("→ liev #08🌱 intake-tracker\nx: what's my macro split this week?");
  });
});

describe("intake pipe: general forward body", () => {
  it("formats text-only forward body", () => {
    const body = formatGeneralForwardBody({
      text: "had a great run today 5k in 22min",
      classification: {
        kind: "recognized",
        agentId: "liev",
        category: "fitness",
        confidence: "high",
        reason: "LLM classified as health",
      },
    });
    expect(body).toContain("had a great run today");
    expect(body).toContain("Routed to liev:fitness");
    expect(body).not.toContain("📎");
  });

  it("formats media forward body with type indicator", () => {
    const body = formatGeneralForwardBody({
      text: "<media:image>",
      mediaType: "image/jpeg",
      classification: {
        kind: "recognized",
        agentId: "liev",
        category: "intake",
        confidence: "high",
        reason: "LLM classified as intake",
      },
    });
    expect(body).toContain("📎");
    expect(body).toContain("image/jpeg");
  });
});

describe("intake pipe: fast-path abstain helpers", () => {
  it("routes explicit health tags to liev without requiring a URL", () => {
    const fastPath = resolveContentRouteFastPath({
      text: "health: imported recovery screenshot",
      mediaType: "image/heic",
    });
    expect(fastPath).toEqual(
      expect.objectContaining({
        kind: "recognized",
        agentId: "liev",
        confidence: "high",
      }),
    );
    if (!fastPath || fastPath.kind !== "recognized") {
      throw new Error("expected recognized fast-path");
    }
    expect(fastPath.category).toBe("health");
  });
});

describe("intake pipe: config resolution", () => {
  it("resolves full config from OpenClawConfig", () => {
    const cfg = {
      agents: {
        contentRouting: {
          enabled: true,
          model: "qwen3.5:9b",
          defaultAgentId: "leo",
          agents: { liev: "health", cody: "code" },
          forward: {
            enabled: true,
            streams: {
              liev: "08🌱 life-loop",
              "liev:intake": "08🌱 intake-tracker",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const routingCfg = resolveContentRoutingConfig(cfg);
    expect(routingCfg).not.toBeNull();
    expect(routingCfg!.enabled).toBe(true);
    expect(routingCfg!.defaultAgentId).toBe("leo");
    expect(routingCfg!.agents).toHaveProperty("liev");

    const forwardCfg = resolveContentForwardConfig(cfg);
    expect(forwardCfg).not.toBeNull();
    expect(forwardCfg!.enabled).toBe(true);
    expect(forwardCfg!.streams["liev:intake"]).toBe("08🌱 intake-tracker");
  });

  it("returns null when contentRouting is disabled", () => {
    const cfg = {
      agents: {
        contentRouting: {
          enabled: false,
          agents: { liev: "health" },
          forward: { enabled: true },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveContentRoutingConfig(cfg)).toBeNull();
  });

  it("returns null when forward is disabled", () => {
    const cfg = {
      agents: {
        contentRouting: {
          enabled: true,
          agents: { liev: "health" },
          forward: { enabled: false },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveContentForwardConfig(cfg)).toBeNull();
  });
});

describe("intake pipe: parseAgentCategory edge cases", () => {
  it("handles agent with hyphen", () => {
    expect(parseAgentCategory("my-agent:review")).toEqual({
      agentId: "my-agent",
      category: "review",
    });
  });

  it("handles agent with underscore", () => {
    expect(parseAgentCategory("my_agent")).toEqual({ agentId: "my_agent" });
  });

  it("strips spaces and special chars", () => {
    const result = parseAgentCategory("  liev : intake  ");
    expect(result.agentId).toBe("liev");
    expect(result.category).toBe("intake");
  });
});
