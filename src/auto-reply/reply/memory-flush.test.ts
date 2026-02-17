import { describe, expect, it, vi } from "vitest";
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

  it("uses config cap when model lookup returns undefined", () => {
    expect(
      resolveMemoryFlushContextWindowTokens({
        modelId: undefined,
        agentCfgContextTokens: 300_000,
      }),
    ).toBe(300_000);
  });

  it("uses config cap when it is smaller than native model window", async () => {
    // Mock lookupContextTokens to simulate a model with 1M native context
    const memoryFlush = await import("./memory-flush.js");
    const contextModule = await import("../../agents/context.js");
    const spy = vi.spyOn(contextModule, "lookupContextTokens").mockReturnValue(1_000_000);

    const result = memoryFlush.resolveMemoryFlushContextWindowTokens({
      modelId: "google/gemini-3-flash-preview",
      agentCfgContextTokens: 300_000,
    });
    expect(result).toBe(300_000);
    spy.mockRestore();
  });

  it("uses native model window when config cap is larger", async () => {
    const contextModule = await import("../../agents/context.js");
    const spy = vi.spyOn(contextModule, "lookupContextTokens").mockReturnValue(200_000);

    const memoryFlush = await import("./memory-flush.js");
    const result = memoryFlush.resolveMemoryFlushContextWindowTokens({
      modelId: "anthropic/claude-haiku-4-5",
      agentCfgContextTokens: 500_000,
    });
    expect(result).toBe(200_000);
    spy.mockRestore();
  });
});
