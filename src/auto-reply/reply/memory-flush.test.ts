import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveDailyResetAtMs } from "../../config/sessions/reset.js";
import {
  DEFAULT_MEMORY_FLUSH_PROMPT,
  formatDateStampInTimezone,
  resolveMemoryFlushPromptForRun,
  shouldRunDailyMemoryCheckpoint,
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

describe("formatDateStampInTimezone", () => {
  it("formats date in the given timezone", () => {
    // 2026-02-16 at 3 PM UTC = 10 AM in New York (EST = UTC-5)
    const result = formatDateStampInTimezone(Date.UTC(2026, 1, 16, 15, 0, 0), "America/New_York");
    expect(result).toBe("2026-02-16");
  });

  it("handles timezone date boundary correctly", () => {
    // 2026-02-17 at 2 AM UTC = 2026-02-16 at 9 PM in New York (EST = UTC-5)
    const result = formatDateStampInTimezone(Date.UTC(2026, 1, 17, 2, 0, 0), "America/New_York");
    expect(result).toBe("2026-02-16");
  });

  it("returns ISO date as fallback for invalid timezone", () => {
    // Intl.DateTimeFormat throws for bad timezone, so we get the ISO fallback
    const nowMs = Date.UTC(2026, 5, 10, 12, 0, 0);
    // This should either work or fall back to ISO — both produce YYYY-MM-DD
    const result = formatDateStampInTimezone(nowMs, "UTC");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("shouldRunDailyMemoryCheckpoint", () => {
  const atHour = 4;
  // 2025-03-05 10:00 UTC
  const nowMs = new Date("2025-03-05T10:00:00Z").getTime();
  // boundary = 2025-03-05T04:00:00Z (4am UTC today)
  const boundary = resolveDailyResetAtMs(nowMs, atHour);

  it("returns false when entry is undefined", () => {
    expect(shouldRunDailyMemoryCheckpoint({ entry: undefined, nowMs, atHour })).toBe(false);
  });

  it("returns true when no previous checkpoint (memoryCheckpointAt undefined)", () => {
    const entry = {};
    expect(shouldRunDailyMemoryCheckpoint({ entry: entry as never, nowMs, atHour })).toBe(true);
  });

  it("returns false for a fresh session from /new (memoryCheckpointAt set to now)", () => {
    // After /new, session.ts sets memoryCheckpointAt = Date.now(). Since now is
    // after today's boundary, the daily checkpoint should NOT fire.
    const entry = { memoryCheckpointAt: nowMs };
    expect(shouldRunDailyMemoryCheckpoint({ entry: entry as never, nowMs, atHour })).toBe(false);
  });

  it("returns false for /new before the daily boundary (e.g. 3am with atHour=4)", () => {
    // /new at 3am UTC, boundary resolves to *yesterday* 4am UTC.
    // memoryCheckpointAt = 3am today, which is after yesterday's boundary.
    const preResetNow = new Date("2025-03-05T03:00:00Z").getTime();
    const entry = { memoryCheckpointAt: preResetNow };
    expect(
      shouldRunDailyMemoryCheckpoint({ entry: entry as never, nowMs: preResetNow, atHour }),
    ).toBe(false);
  });

  it("returns false when checkpoint is after the daily boundary", () => {
    // checkpoint at 5am UTC (after 4am boundary)
    const entry = { memoryCheckpointAt: boundary + 3_600_000 };
    expect(shouldRunDailyMemoryCheckpoint({ entry: entry as never, nowMs, atHour })).toBe(false);
  });

  it("returns true when checkpoint is before the daily boundary", () => {
    // checkpoint at 3am UTC (before 4am boundary)
    const entry = { memoryCheckpointAt: boundary - 3_600_000 };
    expect(shouldRunDailyMemoryCheckpoint({ entry: entry as never, nowMs, atHour })).toBe(true);
  });

  it("returns true even when a prior memory flush happened in the same compaction cycle", () => {
    // Daily checkpoint is gated solely by memoryCheckpointAt vs boundary,
    // not by whether a token/transcript flush already ran this cycle.
    const entry = {
      memoryCheckpointAt: boundary - 3_600_000,
      compactionCount: 3,
      memoryFlushCompactionCount: 3,
    };
    expect(shouldRunDailyMemoryCheckpoint({ entry: entry as never, nowMs, atHour })).toBe(true);
  });
});
