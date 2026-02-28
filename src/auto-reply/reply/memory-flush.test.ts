import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveMemoryFlushContextWindowTokens,
  resolveMemoryFlushPromptForRun,
} from "./memory-flush.js";

describe("resolveMemoryFlushPromptForRun", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store durable notes in memory/YYYY-MM-DD.md",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("memory/2026-02-16.md");
    expect(prompt).toContain("Current time:");
    expect(prompt).toContain("(America/New_York)");
  });

  it("does not append a duplicate current time line", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store notes.\nCurrent time: already present",
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(prompt).toContain("Current time: already present");
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });
});

describe("resolveMemoryFlushContextWindowTokens", () => {
  it("prefers agentCfgContextTokens over model lookup", () => {
    // When agentCfgContextTokens is set, it should win even if the model
    // has a larger native context window. This ensures memory flush
    // thresholds align with the user's configured budget.
    const tokens = resolveMemoryFlushContextWindowTokens({
      modelId: "gpt-5.3-codex", // 272k native window
      agentCfgContextTokens: 150_000,
    });
    expect(tokens).toBe(150_000);
  });

  it("falls back to model lookup when agentCfgContextTokens is undefined", () => {
    const tokens = resolveMemoryFlushContextWindowTokens({
      modelId: undefined,
      agentCfgContextTokens: undefined,
    });
    // Should return DEFAULT_CONTEXT_TOKENS (200k) when both are undefined
    expect(tokens).toBeGreaterThan(0);
  });

  it("uses agentCfgContextTokens even when smaller than model window", () => {
    // This is the critical case: user sets 100k budget on a 272k model.
    // Without the fix, lookupContextTokens would return 272k and shadow
    // the user's 100k budget, making flush threshold unreachable.
    const tokens = resolveMemoryFlushContextWindowTokens({
      modelId: "gpt-5.3-codex",
      agentCfgContextTokens: 100_000,
    });
    expect(tokens).toBe(100_000);
  });
});
