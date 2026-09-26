import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCodeSessionRanOnHostLogin,
  clearObservedProviderUsageWindows,
  noteClaudeCodeSessionRoute,
  observedProviderUsageWindowSetVersion,
  readClaudeCodeUsageSnapshot,
  recordObservedProviderUsageWindows,
} from "./provider-usage.observed.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("provider-usage.observed", () => {
  afterEach(() => {
    clearObservedProviderUsageWindows();
  });

  it("serves the latest observation until each window resets", () => {
    recordObservedProviderUsageWindows(
      "claude-cli",
      [
        { label: "5h", usedPercent: 10, resetAt: 1_000 },
        { label: "Week", usedPercent: 40, resetAt: 5_000 },
      ],
      100,
    );
    recordObservedProviderUsageWindows(
      "claude-cli",
      [
        { label: "5h", usedPercent: 12, resetAt: 1_000 },
        { label: "Week", usedPercent: 41, resetAt: 5_000 },
      ],
      200,
    );

    expect(readClaudeCodeUsageSnapshot(500)).toMatchObject({
      windows: [
        { label: "5h", usedPercent: 12, resetAt: 1_000 },
        { label: "Week", usedPercent: 41, resetAt: 5_000 },
      ],
      observedAt: 200,
    });
    expect(readClaudeCodeUsageSnapshot(1_000)).toMatchObject({
      windows: [{ label: "Week", usedPercent: 41, resetAt: 5_000 }],
      observedAt: 200,
    });
    expect(readClaudeCodeUsageSnapshot(5_000)).toBeUndefined();
    expect(readClaudeCodeUsageSnapshot(0)).toBeUndefined();
  });

  it("does not record windows that could never expire", () => {
    recordObservedProviderUsageWindows("claude-cli", [{ label: "5h", usedPercent: 10 }]);

    expect(readClaudeCodeUsageSnapshot(0)).toBeUndefined();
  });

  it("does not record reset times beyond the longest quota period", () => {
    const observedAt = 1_000_000;
    recordObservedProviderUsageWindows(
      "claude-cli",
      [
        { label: "5h", usedPercent: 10, resetAt: observedAt + 5 * 60 * 60 * 1000 },
        { label: "Week", usedPercent: 40, resetAt: observedAt + 400 * DAY_MS },
      ],
      observedAt,
    );

    expect(readClaudeCodeUsageSnapshot(observedAt)).toMatchObject({
      windows: [{ label: "5h", usedPercent: 10, resetAt: observedAt + 5 * 60 * 60 * 1000 }],
      observedAt,
    });
  });

  it("drops every observation when cleared", () => {
    recordObservedProviderUsageWindows("claude-cli", [
      { label: "5h", usedPercent: 10, resetAt: 1_000 },
    ]);

    clearObservedProviderUsageWindows();

    expect(readClaudeCodeUsageSnapshot(0)).toBeUndefined();
  });

  it("keeps windows a newer partial observation does not mention, reporting the oldest time", () => {
    recordObservedProviderUsageWindows(
      "claude-cli",
      [
        { label: "5h", usedPercent: 10, resetAt: 1_000 },
        { label: "Week", usedPercent: 40, resetAt: 5_000 },
      ],
      100,
    );
    recordObservedProviderUsageWindows(
      "claude-cli",
      [{ label: "5h", usedPercent: 15, resetAt: 1_000 }],
      300,
    );

    expect(readClaudeCodeUsageSnapshot(0)).toMatchObject({
      windows: [
        { label: "Week", usedPercent: 40, resetAt: 5_000 },
        { label: "5h", usedPercent: 15, resetAt: 1_000 },
      ],
      observedAt: 100,
    });
    expect(readClaudeCodeUsageSnapshot(1_000)).toMatchObject({
      windows: [{ label: "Week", usedPercent: 40, resetAt: 5_000 }],
      observedAt: 100,
    });
  });

  it("changes the window-set version only when a provider gains a window", () => {
    const provider = "claude-cli";
    const window = (label: string, usedPercent: number, resetAt: number) => ({
      label,
      usedPercent,
      resetAt,
    });
    const start = observedProviderUsageWindowSetVersion();

    recordObservedProviderUsageWindows(provider, [window("5h", 10, 1_000)], 100);
    expect(observedProviderUsageWindowSetVersion()).toBe(start + 1);

    // A newer reading of a window already observed keeps the version.
    recordObservedProviderUsageWindows(provider, [window("5h", 12, 1_000)], 200);
    expect(observedProviderUsageWindowSetVersion()).toBe(start + 1);

    recordObservedProviderUsageWindows(provider, [window("Week", 40, 5_000)], 300);
    expect(observedProviderUsageWindowSetVersion()).toBe(start + 2);

    // After a reset the next window is new again.
    recordObservedProviderUsageWindows(provider, [window("5h", 1, 19_000)], 1_000);
    expect(observedProviderUsageWindowSetVersion()).toBe(start + 3);

    // Windows that would not be recorded do not change it.
    recordObservedProviderUsageWindows(provider, [{ label: "Month", usedPercent: 5 }], 1_100);
    expect(observedProviderUsageWindowSetVersion()).toBe(start + 3);
  });

  it("keeps each session's latest Claude Code route until cleared", () => {
    expect(claudeCodeSessionRanOnHostLogin("agent:main:a")).toBe(false);
    noteClaudeCodeSessionRoute("agent:main:a", true);
    noteClaudeCodeSessionRoute("agent:main:b", false);
    expect(claudeCodeSessionRanOnHostLogin("agent:main:a")).toBe(true);
    expect(claudeCodeSessionRanOnHostLogin("agent:main:b")).toBe(false);

    // The latest turn decides.
    noteClaudeCodeSessionRoute("agent:main:a", false);
    expect(claudeCodeSessionRanOnHostLogin("agent:main:a")).toBe(false);

    noteClaudeCodeSessionRoute("agent:main:b", true);
    clearObservedProviderUsageWindows();
    expect(claudeCodeSessionRanOnHostLogin("agent:main:b")).toBe(false);
  });
});
