// Covers heartbeat timeout warning emission and suppression behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

function createHeartbeatConfig(every: string): OpenClawConfig {
  return {
    agents: {
      defaults: { heartbeat: { every } },
      list: [{ id: "main", heartbeat: { every } }],
    },
  } as OpenClawConfig;
}

describe("startHeartbeatRunner timeout overflow warnings", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("warns once per runner lifetime when clamping an oversized scheduler delay", async () => {
    const warn = vi.fn();
    const noop = vi.fn();
    const logger = {
      subsystem: "gateway/heartbeat",
      isEnabled: vi.fn(() => true),
      trace: noop,
      debug: noop,
      info: noop,
      warn,
      error: noop,
      fatal: noop,
      raw: noop,
      child: vi.fn(() => logger),
    };

    vi.doMock("../logging/subsystem.js", async () => {
      const actual =
        await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
      return {
        ...actual,
        createSubsystemLogger: vi.fn(() => logger),
      };
    });

    const [
      { startHeartbeatRunner },
      { resetHeartbeatWakeStateForTests },
      { hasDiagnosticLogSemantics },
    ] = await Promise.all([
      import("./heartbeat-runner.js"),
      import("./heartbeat-wake.js"),
      import("../logging/diagnostic-log-internal.js"),
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const cfg = createHeartbeatConfig("365d");
    const runnerA = startHeartbeatRunner({
      cfg,
      runOnce: vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 }),
      stableSchedulerSeed: "seed-0",
    });
    const runnerB = startHeartbeatRunner({
      cfg,
      runOnce: vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 }),
      stableSchedulerSeed: "seed-0",
    });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "heartbeat: scheduled delay exceeds Node setTimeout cap; clamping to ~24.85d",
      expect.objectContaining({
        clampedMs: expect.any(Number),
        rawDelayMs: expect.any(Number),
      }),
    );
    const [, metadata] = warn.mock.calls[0] ?? [];
    expect(hasDiagnosticLogSemantics(metadata as Record<string, unknown>)).toBe(true);
    expect(metadata).not.toHaveProperty("logEvent");
    expect(metadata).not.toHaveProperty("logOutcome");
    expect(metadata).not.toHaveProperty("logReason");

    runnerA.stop();
    runnerB.stop();
    resetHeartbeatWakeStateForTests();
  });
});
