import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveMemoryFlushPromptForRun,
  resolvePeriodicExtractionSettings,
  shouldRunPeriodicExtraction,
  DEFAULT_PERIODIC_EXTRACTION_INTERVAL_MS,
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

describe("resolvePeriodicExtractionSettings", () => {
  it("returns null when not configured", () => {
    expect(resolvePeriodicExtractionSettings({})).toBeNull();
    expect(resolvePeriodicExtractionSettings()).toBeNull();
  });

  it("returns null when enabled is false", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              periodicExtraction: { enabled: false },
            },
          },
        },
      },
    };
    expect(resolvePeriodicExtractionSettings(cfg)).toBeNull();
  });

  it("returns settings with defaults when enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              periodicExtraction: { enabled: true },
            },
          },
        },
      },
    };
    const settings = resolvePeriodicExtractionSettings(cfg);
    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(true);
    expect(settings!.intervalMs).toBe(DEFAULT_PERIODIC_EXTRACTION_INTERVAL_MS);
    expect(settings!.prompt).toContain("fact extraction");
  });

  it("parses custom interval", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              periodicExtraction: { enabled: true, every: "1h" },
            },
          },
        },
      },
    };
    const settings = resolvePeriodicExtractionSettings(cfg);
    expect(settings!.intervalMs).toBe(60 * 60 * 1000);
  });

  it("uses custom prompt when provided", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            memoryFlush: {
              periodicExtraction: { enabled: true, prompt: "Custom extraction prompt" },
            },
          },
        },
      },
    };
    const settings = resolvePeriodicExtractionSettings(cfg);
    expect(settings!.prompt).toContain("Custom extraction prompt");
  });
});

describe("shouldRunPeriodicExtraction", () => {
  const settings = {
    enabled: true,
    intervalMs: 30 * 60 * 1000,
    prompt: "test",
    systemPrompt: "test",
  };

  it("returns false when never run and no token info", () => {
    expect(shouldRunPeriodicExtraction({ settings })).toBe(false);
    expect(shouldRunPeriodicExtraction({ entry: {}, settings })).toBe(false);
  });

  it("returns false when never run and tokens below threshold", () => {
    expect(shouldRunPeriodicExtraction({ entry: { totalTokens: 500 }, settings })).toBe(false);
  });

  it("returns true when never run and tokens above threshold", () => {
    expect(shouldRunPeriodicExtraction({ entry: { totalTokens: 2000 }, settings })).toBe(true);
  });

  it("returns false when recently run", () => {
    const now = Date.now();
    expect(
      shouldRunPeriodicExtraction({
        entry: { lastPeriodicExtractionAt: now - 5 * 60 * 1000 },
        settings,
        nowMs: now,
      }),
    ).toBe(false);
  });

  it("returns true when interval has elapsed", () => {
    const now = Date.now();
    expect(
      shouldRunPeriodicExtraction({
        entry: { lastPeriodicExtractionAt: now - 31 * 60 * 1000 },
        settings,
        nowMs: now,
      }),
    ).toBe(true);
  });
});
