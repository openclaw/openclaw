import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildVitestProgressPulse,
  installVitestGateTimeout,
  installVitestNoOutputWatchdog,
  installVitestProgressPulse,
  resolveDirectNodeVitestArgs,
  resolveVitestGateCleanupTimeoutMs,
  resolveVitestGateExitCode,
  resolveVitestGateJobId,
  resolveVitestGateLogPath,
  resolveVitestGateMetadata,
  resolveVitestGateTimeoutMs,
  resolveVitestNodeArgs,
  resolveVitestNoOutputTimeoutMs,
  resolveVitestProgressPulseIntervalMs,
  resolveVitestProgressPulseMetadata,
  resolveVitestSpawnParams,
  shouldSuppressVitestStderrLine,
} from "../../scripts/run-vitest.mjs";

describe("scripts/run-vitest", () => {
  it("adds --no-maglev to vitest child processes by default", () => {
    expect(resolveVitestNodeArgs({ PATH: "/usr/bin" })).toEqual(["--no-maglev"]);
  });

  it("detects pnpm exec node wrappers that can be spawned directly", () => {
    expect(
      resolveDirectNodeVitestArgs([
        "exec",
        "node",
        "--no-maglev",
        "node_modules/vitest/vitest.mjs",
      ]),
    ).toEqual(["--no-maglev", "node_modules/vitest/vitest.mjs"]);
    expect(resolveDirectNodeVitestArgs(["exec", "vitest", "run"])).toBeNull();
  });

  it("allows opting back into Maglev explicitly", () => {
    expect(
      resolveVitestNodeArgs({
        OPENCLAW_VITEST_ENABLE_MAGLEV: "1",
        PATH: "/usr/bin",
      }),
    ).toStrictEqual([]);
  });

  it("parses the optional no-output timeout env", () => {
    expect(resolveVitestNoOutputTimeoutMs({})).toBeNull();
    expect(resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "2500" })).toBe(
      2500,
    );
    expect(
      resolveVitestNoOutputTimeoutMs({ OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0" }),
    ).toBeNull();
  });

  it("assigns managed gate job ids, log files, timeout budgets, and cleanup budgets", () => {
    const env = {
      OPENCLAW_VITEST_GATE_JOB_ID: "Wave 9 / focused gate",
      OPENCLAW_VITEST_GATE_LOG_DIR: "/tmp/openclaw-tests",
      OPENCLAW_VITEST_GATE_TIMEOUT_MS: "120000",
      OPENCLAW_VITEST_GATE_CLEANUP_TIMEOUT_MS: "7000",
    };

    expect(resolveVitestGateJobId({ env })).toBe("Wave-9-focused-gate");
    expect(resolveVitestGateLogPath({ env, jobId: "Wave-9-focused-gate" })).toBe(
      "/tmp/openclaw-tests/Wave-9-focused-gate.log",
    );
    expect(resolveVitestGateTimeoutMs(env)).toBe(120000);
    expect(resolveVitestGateCleanupTimeoutMs(env)).toBe(7000);
    expect(
      resolveVitestGateMetadata({
        argv: ["run", "src/agents/subagent-spawn.test.ts"],
        env,
      }),
    ).toMatchObject({
      jobId: "Wave-9-focused-gate",
      logPath: "/tmp/openclaw-tests/Wave-9-focused-gate.log",
      timeoutMs: 120000,
      cleanupTimeoutMs: 7000,
      argv: ["run", "src/agents/subagent-spawn.test.ts"],
    });
  });

  it("refuses a green gate result when stale scoped processes were cleaned up", () => {
    expect(
      resolveVitestGateExitCode({
        staleProcessDetected: true,
        timedOut: false,
        code: 0,
      }),
    ).toBe(1);
    expect(
      resolveVitestGateExitCode({
        staleProcessDetected: false,
        timedOut: false,
        code: 0,
      }),
    ).toBe(0);
  });

  it("uses default managed gate log and timeout budgets when not configured", () => {
    const jobId = resolveVitestGateJobId({
      env: {},
      now: () => Date.UTC(2026, 4, 17, 23, 0, 0),
      randomUUID: () => "12345678-aaaa-bbbb-cccc-123456789abc",
    });

    expect(jobId).toBe("vitest-2026-05-17T230000.000Z-12345678");
    expect(resolveVitestGateLogPath({ env: {}, jobId })).toMatch(
      /openclaw-vitest-gates\/vitest-2026-05-17T230000\.000Z-12345678\.log$/,
    );
    expect(resolveVitestGateTimeoutMs({})).toBe(900_000);
    expect(resolveVitestGateTimeoutMs({ OPENCLAW_VITEST_GATE_TIMEOUT_MS: "0" })).toBeNull();
  });

  it("terminates a managed gate when the absolute timeout budget expires", () => {
    vi.useFakeTimers();
    try {
      const timeoutSpy = vi.fn();
      const forceKillSpy = vi.fn();
      const logSpy = vi.fn();

      const teardown = installVitestGateTimeout({
        jobId: "job-1",
        timeoutMs: 1000,
        forceKillAfterMs: 500,
        log: logSpy,
        onTimeout: timeoutSpy,
        onForceKill: forceKillSpy,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      vi.advanceTimersByTime(999);
      expect(timeoutSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] gate job job-1 exceeded timeout budget 1000ms; terminating process group.",
      );
      vi.advanceTimersByTime(500);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] gate job job-1 still alive after timeout SIGTERM; sending SIGKILL.",
      );
      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawns vitest in a detached process group on Unix hosts", () => {
    expect(resolveVitestSpawnParams({ PATH: "/usr/bin" }, "darwin")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    expect(resolveVitestSpawnParams({ PATH: "/usr/bin" }, "win32")).toEqual({
      env: { PATH: "/usr/bin" },
      detached: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
  });

  it("reenables local check policy for local Vitest children", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_LOCAL_CHECK: "1",
      PATH: "/usr/bin",
    });
  });

  it("preserves explicit local-check disablement in CI", () => {
    expect(
      resolveVitestSpawnParams(
        {
          CI: "true",
          OPENCLAW_LOCAL_CHECK: "0",
          PATH: "/usr/bin",
        },
        "linux",
      ).env,
    ).toEqual({
      CI: "true",
      OPENCLAW_LOCAL_CHECK: "0",
      PATH: "/usr/bin",
    });
  });

  it("caps native Rust worker pools for serial Vitest runs", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_TEST_PROJECTS_SERIAL: "1",
          PATH: "/usr/bin",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_TEST_PROJECTS_SERIAL: "1",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "1",
      TOKIO_WORKER_THREADS: "1",
    });
  });

  it("keeps explicit native Rust worker pool settings", () => {
    expect(
      resolveVitestSpawnParams(
        {
          OPENCLAW_VITEST_MAX_WORKERS: "2",
          PATH: "/usr/bin",
          RAYON_NUM_THREADS: "8",
          TOKIO_WORKER_THREADS: "6",
        },
        "darwin",
      ).env,
    ).toEqual({
      OPENCLAW_VITEST_MAX_WORKERS: "2",
      PATH: "/usr/bin",
      RAYON_NUM_THREADS: "8",
      TOKIO_WORKER_THREADS: "6",
    });
  });

  it("suppresses rolldown plugin timing noise while keeping other stderr intact", () => {
    expect(
      shouldSuppressVitestStderrLine(
        "\u001b[33m[PLUGIN_TIMINGS] Warning:\u001b[0m plugin `foo` was slow\n",
      ),
    ).toBe(true);
    expect(shouldSuppressVitestStderrLine("real failure output\n")).toBe(false);
  });

  it("kills silent vitest runs after the configured idle timeout", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const timeoutSpy = vi.fn();
      const forceKillSpy = vi.fn();
      const logSpy = vi.fn();

      const teardown = installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 5000,
        log: logSpy,
        onTimeout: timeoutSpy,
        onForceKill: forceKillSpy,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
      });

      vi.advanceTimersByTime(900);
      expect(timeoutSpy).not.toHaveBeenCalled();

      stdout.emit("data", "still alive");
      vi.advanceTimersByTime(900);
      expect(timeoutSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group.",
      );

      vi.advanceTimersByTime(5000);
      expect(forceKillSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] process group still alive after 5000ms; sending SIGKILL.",
      );

      teardown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes the runner label in watchdog logs when provided", () => {
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const logSpy = vi.fn();

      installVitestNoOutputWatchdog({
        streams: [stdout],
        timeoutMs: 1000,
        forceKillAfterMs: 0,
        label: "run --config test/vitest/vitest.secrets.config.ts",
        log: logSpy,
        onTimeout: () => {},
      });

      vi.advanceTimersByTime(1000);
      expect(logSpy).toHaveBeenCalledWith(
        "[vitest] no output for 1000ms; terminating stalled Vitest process group (run --config test/vitest/vitest.secrets.config.ts).",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats Wave 10 progress pulses without raw output or approval-seeking text", () => {
    const pulse = buildVitestProgressPulse({
      jobId: "wave10-focused-gate",
      planPath:
        "/root/.openclaw/workspace/docs/reports/session-issues-2026-05-17/session-issues-runtime-hardening-implementation-plan.md",
      waveNumber: "10",
      waveTotal: "10",
      elapsedMs: 65_000,
      currentGate: "pnpm vitest run\nProcess exited with code 1\nRAW_LOG_BODY_SENTINEL",
      nextAction: "wait for scoped gate completion",
    });

    expect(pulse).toContain(
      "plan=/root/.openclaw/workspace/docs/reports/session-issues-2026-05-17/session-issues-runtime-hardening-implementation-plan.md",
    );
    expect(pulse).toContain("wave=10/10");
    expect(pulse).toContain("elapsed=1m5s");
    expect(pulse).toContain("gate=[suppressed raw output; see gate log]");
    expect(pulse).toContain("next=wait for scoped gate completion");
    expect(pulse).not.toContain("RAW_LOG_BODY_SENTINEL");
    expect(pulse.toLowerCase()).not.toContain("approve");
  });

  it("emits concise progress before the no-output watchdog threshold", () => {
    vi.useFakeTimers();
    try {
      const logSpy = vi.fn();
      let now = 10_000;
      const teardown = installVitestProgressPulse({
        intervalMs: resolveVitestProgressPulseIntervalMs({
          OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "4000",
        }),
        startedAtMs: now,
        nowFn: () => now,
        setTimeoutFn: setTimeout,
        clearTimeoutFn: clearTimeout,
        log: logSpy,
        jobId: "wave10-progress",
        metadata: resolveVitestProgressPulseMetadata({
          env: {
            OPENCLAW_ACTIVE_PLAN_PATH: "docs/plan.md",
            OPENCLAW_ACTIVE_WAVE_NUMBER: "10",
            OPENCLAW_ACTIVE_WAVE_TOTAL: "10",
            OPENCLAW_CURRENT_GATE: "focused agents-core gate",
            OPENCLAW_NEXT_ACTION: "wait for results",
          },
          argv: ["run", "src/agents/internal-events.test.ts"],
        }),
      });

      vi.advanceTimersByTime(1_999);
      expect(logSpy).not.toHaveBeenCalled();
      now += 2_000;
      vi.advanceTimersByTime(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("plan=docs/plan.md");
      expect(line).toContain("wave=10/10");
      expect(line).toContain("elapsed=2s");
      expect(line).toContain("gate=focused agents-core gate");
      expect(line).toContain("next=wait for results");
      expect(line).not.toContain("\n");
      teardown();
    } finally {
      vi.useRealTimers();
    }
  });
});
