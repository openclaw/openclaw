// Gateway startup watchdog tests.
//
// Verifies the watchdog observes the in-flight diagnostic phase stack
// once, writes a single structured line to stderr, and never re-arms.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticPhasesForTest, withDiagnosticPhase } from "./diagnostic-phase.js";
import {
  armStartupWatchdog,
  cancelStartupWatchdog,
  emitStartupWatchdogFiredLine,
  getLastStartupWatchdogLineForTest,
  isStartupWatchdogArmedForTest,
  resetStartupWatchdogForTest,
  resolveStartupWatchdogThresholdMs,
} from "./gateway-startup-watchdog.js";

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Replace process.stderr.write with a capture; signature matches the
  // overload subset the watchdog uses (single string argument).
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    lines,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("resolveStartupWatchdogThresholdMs", () => {
  it("defaults to 60s when the env var is unset", () => {
    expect(resolveStartupWatchdogThresholdMs({})).toBe(60_000);
  });

  it("defaults to 60s when the env var is blank", () => {
    expect(resolveStartupWatchdogThresholdMs({ OPENCLAW_STARTUP_WATCHDOG_MS: "" })).toBe(60_000);
  });

  it("returns 0 when the operator explicitly disables the watchdog", () => {
    expect(resolveStartupWatchdogThresholdMs({ OPENCLAW_STARTUP_WATCHDOG_MS: "0" })).toBe(0);
  });

  it("parses positive integer overrides", () => {
    expect(
      resolveStartupWatchdogThresholdMs({
        OPENCLAW_STARTUP_WATCHDOG_MS: "1500",
      }),
    ).toBe(1500);
  });

  it("falls back to disabled (NOT the default) for negative or non-numeric values", () => {
    // Defensive parsing for an external-boundary value: a malformed
    // OPENCLAW_STARTUP_WATCHDOG_MS override must NOT silently re-arm the
    // default 60s. Sysdes (Q2-followup, 2026-06-07): "NaN-ish / negative /
    // non-numeric → disabled, NOT default."
    expect(resolveStartupWatchdogThresholdMs({ OPENCLAW_STARTUP_WATCHDOG_MS: "-5" })).toBe(0);
    expect(
      resolveStartupWatchdogThresholdMs({
        OPENCLAW_STARTUP_WATCHDOG_MS: "notanumber",
      }),
    ).toBe(0);
    expect(resolveStartupWatchdogThresholdMs({ OPENCLAW_STARTUP_WATCHDOG_MS: "NaN" })).toBe(0);
  });

  it("treats Infinity/-Infinity overrides as disabled (not finite)", () => {
    expect(
      resolveStartupWatchdogThresholdMs({
        OPENCLAW_STARTUP_WATCHDOG_MS: "Infinity",
      }),
    ).toBe(0);
    expect(
      resolveStartupWatchdogThresholdMs({
        OPENCLAW_STARTUP_WATCHDOG_MS: "-Infinity",
      }),
    ).toBe(0);
  });
});

describe("armStartupWatchdog", () => {
  beforeEach(() => {
    resetStartupWatchdogForTest();
    resetDiagnosticPhasesForTest();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetStartupWatchdogForTest();
    resetDiagnosticPhasesForTest();
  });

  it("is a no-op when the threshold is 0", () => {
    expect(armStartupWatchdog({ thresholdMs: 0 })).toBe(false);
    expect(isStartupWatchdogArmedForTest()).toBe(false);
  });

  it("is a no-op when the threshold is negative or non-finite", () => {
    expect(armStartupWatchdog({ thresholdMs: -1 })).toBe(false);
    expect(armStartupWatchdog({ thresholdMs: Number.NaN })).toBe(false);
    expect(isStartupWatchdogArmedForTest()).toBe(false);
  });

  it("arms a timer and reports it as armed", () => {
    expect(armStartupWatchdog({ thresholdMs: 5_000 })).toBe(true);
    expect(isStartupWatchdogArmedForTest()).toBe(true);
  });

  it("refuses to double-arm", () => {
    expect(armStartupWatchdog({ thresholdMs: 5_000 })).toBe(true);
    expect(armStartupWatchdog({ thresholdMs: 5_000 })).toBe(false);
    expect(isStartupWatchdogArmedForTest()).toBe(true);
  });

  it("emits a single stderr line with the in-flight phase tree when it fires", async () => {
    const capture = captureStderr();
    try {
      armStartupWatchdog({ thresholdMs: 5_000 });

      // Build a 2-level diagnostic phase stack that is still in flight
      // when the watchdog fires.
      let resolveInner: (() => void) | undefined;
      const innerPending = new Promise<void>((res) => {
        resolveInner = res;
      });
      const outer = withDiagnosticPhase("cli.outer-step", async () => {
        await withDiagnosticPhase("cli.inner-step", async () => {
          await innerPending;
        });
      });

      // Let the microtasks run so both phases enter the active stack
      // before we advance the fake clock past the threshold.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(capture.lines).toHaveLength(1);
      const line = capture.lines[0] ?? "";
      expect(line).toMatch(/^\[startup-watchdog\] /);
      expect(line).toContain('stuck step="cli.inner-step"');
      expect(line).toContain("threshold=5000ms");
      // Phase names inside pending=[...] are JSON-quoted so embedded
      // newlines/quotes cannot break the single-line parse contract.
      expect(line).toMatch(/pending=\["cli\.outer-step"@[0-9.]+ms "cli\.inner-step"@[0-9.]+ms\]/);
      expect(line.endsWith("\n")).toBe(true);
      expect(isStartupWatchdogArmedForTest()).toBe(false);
      expect(getLastStartupWatchdogLineForTest()).toBe(line);

      resolveInner?.();
      await outer;
    } finally {
      capture.restore();
    }
  });

  it("does not fire when cancelled before the threshold elapses", async () => {
    const capture = captureStderr();
    try {
      armStartupWatchdog({ thresholdMs: 5_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      cancelStartupWatchdog();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(capture.lines).toHaveLength(0);
      expect(isStartupWatchdogArmedForTest()).toBe(false);
      expect(getLastStartupWatchdogLineForTest()).toBeUndefined();
    } finally {
      capture.restore();
    }
  });

  it("fires at most once even if more time elapses after the threshold", async () => {
    const capture = captureStderr();
    try {
      armStartupWatchdog({ thresholdMs: 1_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(capture.lines).toHaveLength(1);
      expect(isStartupWatchdogArmedForTest()).toBe(false);
    } finally {
      capture.restore();
    }
  });

  it("cancel-after-fire is a safe no-op", () => {
    const capture = captureStderr();
    try {
      emitStartupWatchdogFiredLine(1_000);
      expect(capture.lines).toHaveLength(1);
      // Should not throw and should not write another line.
      cancelStartupWatchdog();
      cancelStartupWatchdog();
      expect(capture.lines).toHaveLength(1);
    } finally {
      capture.restore();
    }
  });
});

describe("emitStartupWatchdogFiredLine", () => {
  beforeEach(() => {
    resetStartupWatchdogForTest();
    resetDiagnosticPhasesForTest();
  });

  afterEach(() => {
    resetStartupWatchdogForTest();
    resetDiagnosticPhasesForTest();
  });

  it("reports an empty pending tree as []", () => {
    const capture = captureStderr();
    try {
      const line = emitStartupWatchdogFiredLine(60_000);
      expect(capture.lines).toEqual([line]);
      expect(line).toContain("pending=[]");
      expect(line).toContain('stuck step="(unknown)"');
      expect(line).toContain("threshold=60000ms");
    } finally {
      capture.restore();
    }
  });

  it("ignores stderr write errors so the watchdog cannot crash startup", () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => {
      throw new Error("stderr unavailable");
    }) as typeof process.stderr.write;
    try {
      expect(() => emitStartupWatchdogFiredLine(60_000)).not.toThrow();
    } finally {
      process.stderr.write = original;
    }
  });

  it("escapes embedded newlines and quotes in phase names so the line stays single-line", async () => {
    // Sysdes follow-up 2026-06-07: "formatter must escape `\n` and `"` in
    // phase names". Phase names are string literals in source today, but if a
    // future caller passes user-derived content an unescaped newline would
    // break the single-line parse contract operators rely on when grepping
    // production stderr.
    const capture = captureStderr();
    try {
      await withDiagnosticPhase('with"quote\nnewline', async () => {
        emitStartupWatchdogFiredLine(60_000);
      });
      expect(capture.lines).toHaveLength(1);
      const line = capture.lines[0] ?? "";
      // Exactly one trailing newline: the structured line itself.
      expect(line.match(/\n/g)?.length).toBe(1);
      expect(line.endsWith("\n")).toBe(true);
      // `stuck step=` value is JSON-quoted with embedded `\n` and `\"`.
      expect(line).toContain('stuck step="with\\"quote\\nnewline"');
      // `pending=[...]` entry uses the same quoting/escaping discipline.
      expect(line).toMatch(/pending=\["with\\"quote\\nnewline"@[0-9.]+ms\]/);
    } finally {
      capture.restore();
    }
  });
});
