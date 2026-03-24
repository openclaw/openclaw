import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  DEFAULT_MEMORY_FLUSH_PROMPT,
  resolveMemoryFlushPromptForRun,
  resolveMemoryFlushRelativePathForRun,
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
    expect(prompt).toContain(
      "Current time: Monday, February 16th, 2026 — 10:00 AM (America/New_York) / 2026-02-16 15:00 UTC",
    );
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

  it("resolves the canonical relative memory path using user timezone", () => {
    const relativePath = resolveMemoryFlushRelativePathForRun({
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(relativePath).toBe("memory/2026-02-16.md");
  });

  it("uses the per-agent userTimezone override for the canonical memory path", () => {
    const relativePath = resolveMemoryFlushRelativePathForRun({
      cfg: {
        agents: {
          defaults: {
            userTimezone: "America/New_York",
            timeFormat: "12",
          },
          list: [
            {
              id: "work",
              userTimezone: "America/Los_Angeles",
            },
          ],
        },
      } as OpenClawConfig,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
      agentId: "work",
    });

    expect(relativePath).toBe("memory/2026-02-16.md");
  });

  it("uses the per-agent userTimezone override when configured", () => {
    const prompt = resolveMemoryFlushPromptForRun({
      prompt: "Store durable notes in memory/YYYY-MM-DD.md",
      cfg: {
        agents: {
          defaults: {
            userTimezone: "America/New_York",
            timeFormat: "12",
          },
          list: [
            {
              id: "work",
              userTimezone: "America/Los_Angeles",
            },
          ],
        },
      } as OpenClawConfig,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
      agentId: "work",
    });

    expect(prompt).toContain("memory/2026-02-16.md");
    expect(prompt).toContain(
      "Current time: Monday, February 16th, 2026 — 7:00 AM (America/Los_Angeles) / 2026-02-16 15:00 UTC",
    );
  });
});

describe("DEFAULT_MEMORY_FLUSH_PROMPT", () => {
  it("includes append-only instruction to prevent overwrites (#6877)", () => {
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toMatch(/APPEND/i);
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("do not overwrite");
  });

  it("includes anti-fragmentation instruction to prevent timestamped variant files (#34919)", () => {
    // Agents must not create YYYY-MM-DD-HHMM.md variants alongside the canonical file
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("timestamped variant");
    expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("YYYY-MM-DD.md");
  });
});
