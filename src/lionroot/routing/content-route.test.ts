import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  classifyContentWithLLM,
  isInvestigationClassification,
  isRecognizedContentRoute,
  parseAgentCategory,
  resolveContentRouteFastPath,
  resolveContentRouteWithStickiness,
  resolveContentRoutingConfig,
  resolveInvestigationFastPath,
  resolveTwitterContent,
  type ContentRoutingConfig,
} from "./content-route.js";
import { clearAllSticky, resolveWithStickiness, getStickyEntry } from "./content-session-sticky.js";

afterEach(() => {
  clearAllSticky();
  vi.restoreAllMocks();
});

const AGENT_DESCRIPTIONS: Record<string, string> = {
  liev: "Health, food tracking, meals, nutrition, wellness, exercise",
  cody: "Software engineering, code, bugs, PRs, commits, GitHub",
  finn: "Finance, expenses, budgets, invoices, payments",
  main: "General conversation, anything else",
};

const baseCfg: ContentRoutingConfig = {
  enabled: true,
  model: "test-model",
  ollamaUrl: "http://localhost:11434",
  stickyTimeoutMs: 600_000,
  agents: AGENT_DESCRIPTIONS,
};

// ── Agent:category parsing tests ──

describe("parseAgentCategory", () => {
  it("parses plain agent name", () => {
    expect(parseAgentCategory("liev")).toEqual({ agentId: "liev" });
  });

  it("parses agent:category format", () => {
    expect(parseAgentCategory("liev:intake")).toEqual({ agentId: "liev", category: "intake" });
  });

  it("parses agent:category with extra punctuation", () => {
    expect(parseAgentCategory("cody:review.")).toEqual({ agentId: "cody", category: "review" });
  });

  it("handles empty category after colon", () => {
    expect(parseAgentCategory("liev:")).toEqual({ agentId: "liev" });
  });

  it("strips non-alphanumeric characters", () => {
    expect(parseAgentCategory("  liev  ")).toEqual({ agentId: "liev" });
  });
});

// ── Fast-path tests ──

describe("resolveInvestigationFastPath", () => {
  it("detects explicit investigation prefixes when enabled", () => {
    const result = resolveInvestigationFastPath({
      text: "investigate: would BlueBubbles be better than our current relay?",
      investigationEnabled: true,
      agentId: "leo",
    });
    expect(result).toEqual({
      kind: "recognized",
      agentId: "leo",
      category: "investigate",
      confidence: "high",
      reason: "fast-path: investigate tag",
    });
    expect(isInvestigationClassification(result)).toBe(true);
  });

  it("returns null when investigation is disabled", () => {
    const result = resolveInvestigationFastPath({
      text: "research: compare our iMessage routing options",
      investigationEnabled: false,
      agentId: "leo",
    });
    expect(result).toBeNull();
  });
});

describe("resolveContentRouteFastPath", () => {
  it("routes GitHub URLs to Cody", () => {
    const result = resolveContentRouteFastPath({
      text: "Check this out https://github.com/openclaw/openclaw/pull/123",
    });
    expect(result).not.toBeNull();
    expect(isRecognizedContentRoute(result)).toBe(true);
    if (!isRecognizedContentRoute(result)) {
      throw new Error("expected recognized fast-path");
    }
    expect(result.agentId).toBe("cody");
    expect(result.confidence).toBe("high");
    expect(result.reason).toContain("GitHub URL");
  });

  it("returns null for non-matching URLs", () => {
    const result = resolveContentRouteFastPath({
      text: "Check https://example.com/page",
    });
    expect(result).toBeNull();
  });

  it("returns null for plain text without URLs", () => {
    const result = resolveContentRouteFastPath({
      text: "eggs and avocado toast for breakfast",
    });
    expect(result).toBeNull();
  });

  it("detects GitHub URLs among other URLs", () => {
    const result = resolveContentRouteFastPath({
      text: "See https://docs.example.com and https://github.com/user/repo/issues/42",
    });
    expect(result).not.toBeNull();
    if (!isRecognizedContentRoute(result)) {
      throw new Error("expected recognized fast-path");
    }
    expect(result.agentId).toBe("cody");
  });

  it("routes explicit health prefixes to liev without requiring a URL", () => {
    const result = resolveContentRouteFastPath({
      text: "sleep: awful last night",
    });
    expect(result).toEqual(
      expect.objectContaining({
        kind: "recognized",
        agentId: "liev",
        category: "health",
        confidence: "high",
      }),
    );
  });
});

// ── Session stickiness tests ──

describe("resolveWithStickiness", () => {
  it("uses new classification when no sticky entry exists", () => {
    const result = resolveWithStickiness({
      peer: "+15555550001",
      newAgentId: "liev",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
    });
    expect(result).toBe("liev");
  });

  it("stays sticky for medium confidence different agent", () => {
    // Set initial sticky
    resolveWithStickiness({
      peer: "+15555550002",
      newAgentId: "liev",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
      now: 1000,
    });

    // New classification wants cody but medium confidence
    const result = resolveWithStickiness({
      peer: "+15555550002",
      newAgentId: "cody",
      newConfidence: "medium",
      stickyTimeoutMs: 600_000,
      now: 2000,
    });
    expect(result).toBe("liev"); // stays sticky
  });

  it("switches on high confidence different agent", () => {
    // Set initial sticky
    resolveWithStickiness({
      peer: "+15555550003",
      newAgentId: "liev",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
      now: 1000,
    });

    // High confidence switch to cody
    const result = resolveWithStickiness({
      peer: "+15555550003",
      newAgentId: "cody",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
      now: 2000,
    });
    expect(result).toBe("cody"); // switches
  });

  it("uses new classification after sticky timeout", () => {
    resolveWithStickiness({
      peer: "+15555550004",
      newAgentId: "liev",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
      now: 1000,
    });

    // After timeout, even low confidence gets through
    const result = resolveWithStickiness({
      peer: "+15555550004",
      newAgentId: "cody",
      newConfidence: "low",
      stickyTimeoutMs: 600_000,
      now: 700_000, // well past 10 min
    });
    expect(result).toBe("cody");
  });

  it("refreshes timestamp on same agent", () => {
    const now = Date.now();
    resolveWithStickiness({
      peer: "+15555550005",
      newAgentId: "liev",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
      now,
    });

    resolveWithStickiness({
      peer: "+15555550005",
      newAgentId: "liev",
      newConfidence: "medium",
      stickyTimeoutMs: 600_000,
      now: now + 1000,
    });

    const entry = getStickyEntry("+15555550005");
    expect(entry?.lastAt).toBe(now + 1000);
  });

  it("stays sticky for low confidence", () => {
    resolveWithStickiness({
      peer: "+15555550006",
      newAgentId: "liev",
      newConfidence: "high",
      stickyTimeoutMs: 600_000,
      now: 1000,
    });

    // "hey what's up" → low confidence → stays with Liev
    const result = resolveWithStickiness({
      peer: "+15555550006",
      newAgentId: "main",
      newConfidence: "low",
      stickyTimeoutMs: 600_000,
      now: 2000,
    });
    expect(result).toBe("liev");
  });
});

// ── Config resolution tests ──

describe("resolveContentRoutingConfig", () => {
  it("returns null when agents.contentRouting is missing", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveContentRoutingConfig(cfg)).toBeNull();
  });

  it("returns null when contentRouting.enabled is false", () => {
    const cfg = {
      agents: { contentRouting: { enabled: false, agents: { main: "General" } } },
    } as unknown as OpenClawConfig;
    expect(resolveContentRoutingConfig(cfg)).toBeNull();
  });

  it("returns null when agents map is empty", () => {
    const cfg = {
      agents: { contentRouting: { enabled: true, agents: {} } },
    } as unknown as OpenClawConfig;
    expect(resolveContentRoutingConfig(cfg)).toBeNull();
  });

  it("returns config when valid", () => {
    const cfg = {
      agents: {
        contentRouting: {
          enabled: true,
          model: "qwen3:14b",
          ollamaUrl: "http://localhost:11434",
          stickyTimeoutMs: 300_000,
          defaultAgentId: "leo",
          agents: { liev: "Health", cody: "Code" },
          investigation: {
            enabled: true,
            maxSteps: 4,
            promotionThreshold: "high",
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveContentRoutingConfig(cfg);
    expect(result).not.toBeNull();
    expect(result!.model).toBe("qwen3:14b");
    expect(result!.stickyTimeoutMs).toBe(300_000);
    expect(result!.defaultAgentId).toBe("leo");
    expect(result!.agents).toEqual({ liev: "Health", cody: "Code" });
    expect(result!.investigation).toEqual({
      enabled: true,
      maxSteps: 4,
      maxDurationMs: undefined,
      maxTokens: undefined,
      promotionThreshold: "high",
      defaultAgentId: undefined,
    });
  });
});

// ── LLM classification tests ──

describe("classifyContentWithLLM", () => {
  it("returns agent from successful LLM response", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: "liev" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await classifyContentWithLLM({
      text: "eggs and avocado toast",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "recognized",
        agentId: "liev",
        confidence: "high",
      }),
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    const fetchArgs = mockFetch.mock.calls[0];
    expect(fetchArgs[0]).toBe("http://localhost:11434/api/chat");
  });

  it("handles LLM response with extra text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "cody." } }),
      }),
    );

    const result = await classifyContentWithLLM({
      text: "fix the auth bug",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "recognized",
        agentId: "cody",
        confidence: "medium",
      }),
    ); // not clean response
  });

  it("abstains on unrecognized agent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "unknown-agent" } }),
      }),
    );

    const result = await classifyContentWithLLM({
      text: "some random text",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "abstain",
        confidence: "low",
      }),
    );
  });

  it("abstains on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("connection refused")));

    const result = await classifyContentWithLLM({
      text: "hello",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result.kind).toBe("abstain");
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("timeout/error");
  });

  it("abstains on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }));

    const result = await classifyContentWithLLM({
      text: "hello",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result.kind).toBe("abstain");
    expect(result.confidence).toBe("low");
    expect(result.reason).toContain("LLM error");
  });

  it("includes media type hint in prompt", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: "liev" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await classifyContentWithLLM({
      text: "<media:image>",
      mediaType: "image/jpeg",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("image/jpeg attachment");
  });

  it("includes attached text content in prompt", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: "cody" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await classifyContentWithLLM({
      text: "please route this",
      mediaType: "text/plain",
      attachmentText: "Stack trace line 1\nStack trace line 2",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt = body.messages[0].content;
    expect(prompt).toContain("Attached text content:");
    expect(prompt).toContain("Stack trace line 1");
  });

  it("parses agent:category from LLM response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "liev:intake" } }),
      }),
    );

    const result = await classifyContentWithLLM({
      text: "had eggs for breakfast",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "recognized",
        agentId: "liev",
        category: "intake",
        confidence: "high",
      }),
    );
  });

  it("returns category as undefined for plain agent response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: { content: "cody" } }),
      }),
    );

    const result = await classifyContentWithLLM({
      text: "review this PR",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "recognized",
        agentId: "cody",
      }),
    );
    if (result.kind !== "recognized") {
      throw new Error("expected recognized classification");
    }
    expect(result.category).toBeUndefined();
  });

  it("includes tweet text in prompt", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: { content: "liev" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await classifyContentWithLLM({
      text: "https://x.com/user/status/123",
      tweetText: "Just had the best smoothie bowl ever",
      model: "test-model",
      ollamaUrl: "http://localhost:11434",
      agentDescriptions: AGENT_DESCRIPTIONS,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt = body.messages[0].content;
    expect(prompt).toContain("smoothie bowl");
    expect(prompt).toContain("Tweet content:");
  });
});

// ── Twitter resolution tests ──

describe("resolveTwitterContent", () => {
  it("returns null for non-Twitter URLs", async () => {
    const result = await resolveTwitterContent("https://example.com/page");
    expect(result).toBeNull();
  });

  it("extracts tweet ID from x.com URL", async () => {
    vi.mock("../../process/exec.js", () => ({
      runExec: vi.fn().mockResolvedValue({
        stdout: "This is tweet text about supplements",
        stderr: "",
      }),
    }));

    // Import the mocked module
    const { resolveTwitterContent: resolve } = await import("./content-route.js");
    const result = await resolve("Check this https://x.com/user/status/1234567890");

    if (result) {
      expect(result.tweetId).toBe("1234567890");
      expect(result.tweetText).toBe("This is tweet text about supplements");
    }
  });
});

// ── Orchestrator tests ──

describe("resolveContentRouteWithStickiness", () => {
  it("returns null for group chats", async () => {
    const result = await resolveContentRouteWithStickiness({
      cfg: baseCfg,
      text: "fix the bug",
      peer: "group-123",
      isGroup: true,
    });
    expect(result).toBeNull();
  });

  it("returns null for empty text", async () => {
    const result = await resolveContentRouteWithStickiness({
      cfg: baseCfg,
      text: "",
      peer: "+15555550001",
      isGroup: false,
    });
    expect(result).toBeNull();
  });

  it("uses fast-path for GitHub URLs without calling LLM", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const result = await resolveContentRouteWithStickiness({
      cfg: baseCfg,
      text: "https://github.com/openclaw/openclaw/pull/123",
      peer: "+15555550001",
      isGroup: false,
    });

    expect(result).not.toBeNull();
    if (!isRecognizedContentRoute(result)) {
      throw new Error("expected recognized fast-path");
    }
    expect(result.agentId).toBe("cody");
    // LLM should not be called for fast-path
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns abstain when a follow-up LLM response is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: { content: "liev" } }),
      }),
    );

    const result1 = await resolveContentRouteWithStickiness({
      cfg: baseCfg,
      text: "eggs and avocado toast",
      peer: "+15555550010",
      isGroup: false,
    });
    if (!isRecognizedContentRoute(result1)) {
      throw new Error("expected recognized classification");
    }
    expect(result1.agentId).toBe("liev");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message: { content: "main" } }),
      }),
    );

    const result2 = await resolveContentRouteWithStickiness({
      cfg: baseCfg,
      text: "thanks",
      peer: "+15555550010",
      isGroup: false,
    });
    expect(result2).toEqual(
      expect.objectContaining({
        kind: "abstain",
        confidence: "low",
      }),
    );
  });
});
