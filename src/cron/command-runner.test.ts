import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Wrap runCommandWithTimeout in a spy that delegates to the real implementation
// by default. This lets individual tests override it to assert the options
// passed by runCronCommandJob without affecting tests that run real commands.
vi.mock("../process/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: vi.fn(actual.runCommandWithTimeout),
  };
});

import { runCommandWithTimeout } from "../process/exec.js";
import { runCronCommandJob } from "./command-runner.js";
import type { CronJob } from "./types.js";

function makeCommandJob(payload: Extract<CronJob["payload"], { kind: "command" }>): CronJob {
  const now = Date.now();
  return {
    id: "command-job",
    name: "Command job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

function isProcessRunning(pid: number): boolean {
  const result = spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  const state = result.stdout.trim();
  if (result.status === 0) {
    return !state.startsWith("Z");
  }
  if (result.status === 1 && state === "" && result.stderr.trim() === "") {
    return false;
  }
  throw new Error(
    `ps failed with status ${result.status ?? "unknown"}: ${result.stderr.trim() || "no output"}`,
  );
}

describe("runCronCommandJob", () => {
  it("runs command argv and returns stdout as the deliverable summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('hello from cron')"],
        timeoutSeconds: 5,
      }),
      nowMs: () => 123,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello from cron");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 123,
      source: "exec",
      severity: "info",
      exitCode: 0,
    });
  });

  it("preserves exact NO_REPLY stdout for outbound suppression", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('NO_REPLY\\n')"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("NO_REPLY");
  });

  it("marks non-zero exit codes as cron errors and keeps stderr as summary", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stderr.write('bad thing'); process.exit(7)"],
        timeoutSeconds: 5,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command exited with code 7");
    expect(result.summary).toBe("bad thing");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
      exitCode: 7,
    });
  });

  it("preserves early action-required command output when the captured tail is truncated", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [
          process.execPath,
          "-e",
          [
            "process.stdout.write('Visit https://example.com/device and enter code ABCD-EFGH\\n')",
            "process.stdout.write('x'.repeat(200))",
          ].join(";"),
        ],
        timeoutSeconds: 5,
        outputMaxBytes: 24,
      }),
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe(
      `action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\n${"x".repeat(24)}`,
    );
    expect(result.diagnostics?.summary).toBe(result.summary);
    expect(result.diagnostics?.entries[0]).toMatchObject({ truncated: true });
  });

  it("marks command timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 0.05,
      }),
      nowMs: () => 456,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 456,
      source: "exec",
      severity: "error",
    });
  });

  it.skipIf(process.platform === "win32")("kills shell process groups on timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-command-"));
    const childPidPath = path.join(tempDir, "child.pid");
    const shellCommand = [
      "sleep 60 &",
      "child_pid=$!",
      `printf '%s' "$child_pid" > ${JSON.stringify(childPidPath)}`,
      'wait "$child_pid"',
    ].join("\n");

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: ["sh", "-lc", shellCommand],
        timeoutSeconds: 0.5,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command timed out");

    const childPid = Number.parseInt(await fs.readFile(childPidPath, "utf8"), 10);
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await expect.poll(() => isProcessRunning(childPid)).toBe(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("marks no-output timeouts as cron errors", async () => {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 5,
        noOutputTimeoutSeconds: 0.05,
      }),
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command produced no output before noOutputTimeoutSeconds");
    expect(result.diagnostics?.entries[0]).toMatchObject({
      source: "exec",
      severity: "error",
    });
  });

  it("marks aborted command runs as cron errors", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('should not run')"],
        timeoutSeconds: 5,
      }),
      abortSignal: controller.signal,
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("command stopped");
    expect(result.summary).toBeUndefined();
  });

  it("negative timeoutSeconds falls back to default instead of unbounded", async () => {
    // Regression: negative timeoutSeconds used to map to
    // EFFECTIVELY_UNBOUNDED_TIMEOUT_MS (~24.8 days), hanging doctor/cron.
    // It must now fall back to DEFAULT_COMMAND_TIMEOUT_MS (10 min).
    const stub = vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
      termination: "exit" as const,
    });

    for (const badTimeout of [-1, -60]) {
      stub.mockClear();
      await runCronCommandJob({
        job: makeCommandJob({
          kind: "command",
          argv: [process.execPath, "-e", "process.stdout.write('ok')"],
          timeoutSeconds: badTimeout,
        }),
      });
      expect(stub).toHaveBeenCalledTimes(1);
      const options = stub.mock.calls[0]?.[1] as { timeoutMs?: number };
      // Must be 600000 (10 min default), NOT 2147483647 (unbounded).
      expect(options?.timeoutMs).toBe(600_000);
      expect(options?.timeoutMs).not.toBe(2_147_483_647);
    }
    stub.mockRestore();
  });

  it("zero timeoutSeconds preserves no-timeout contract (unbounded)", async () => {
    // 0 is an intentionally supported "no timeout" value per
    // docs/automation/cron-jobs.md. It must remain unbounded, not fall back
    // to the default.
    const stub = vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
      termination: "exit" as const,
    });

    await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        timeoutSeconds: 0,
      }),
    });
    const options = stub.mock.calls[0]?.[1] as { timeoutMs?: number };
    expect(options?.timeoutMs).toBe(2_147_483_647);
    stub.mockRestore();
  });

  it("negative noOutputTimeoutSeconds is omitted instead of arming unbounded deadline", async () => {
    // Regression: negative noOutputTimeoutSeconds used to map to
    // EFFECTIVELY_UNBOUNDED_TIMEOUT_MS. It must now be omitted (undefined)
    // so the runner does not arm a ~24.8-day no-output deadline.
    const stub = vi.mocked(runCommandWithTimeout).mockResolvedValue({
      stdout: "ok",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
      termination: "exit" as const,
    });

    await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('ok')"],
        timeoutSeconds: 5,
        noOutputTimeoutSeconds: -1,
      }),
    });
    const options = stub.mock.calls[0]?.[1] as {
      noOutputTimeoutMs?: number;
    };
    expect(options?.noOutputTimeoutMs).toBeUndefined();
    stub.mockRestore();
  });

  it("real command run with negative timeout completes and arms default deadline", async () => {
    // Real behavior proof: run a REAL command (no mockResolvedValue) with a
    // negative timeoutSeconds. The spy observes the actual timeoutMs passed
    // to runCommandWithTimeout while the real command executes and returns.
    // Without the fix, timeoutMs would be 2_147_483_647 (~24.8 days);
    // with the fix, it falls back to 600_000 (10 min default).
    const spy = vi.mocked(runCommandWithTimeout);
    spy.mockClear();

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('real-ok')"],
        timeoutSeconds: -1,
      }),
    });

    // Real command executed successfully.
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("real-ok");
    // Spy observed the fallback timeout, not the unbounded value.
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0]?.[1] as { timeoutMs?: number };
    expect(options?.timeoutMs).toBe(600_000);
    expect(options?.timeoutMs).not.toBe(2_147_483_647);
  });

  it("real command run with zero timeout arms unbounded deadline", async () => {
    // Real behavior proof: run a REAL command (no mockResolvedValue) with
    // timeoutSeconds: 0. The spy observes the actual timeoutMs is
    // 2_147_483_647 (unbounded), preserving the documented "no timeout"
    // contract, while the real command executes and returns.
    const spy = vi.mocked(runCommandWithTimeout);
    spy.mockClear();

    const result = await runCronCommandJob({
      job: makeCommandJob({
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('real-zero')"],
        timeoutSeconds: 0,
      }),
    });

    // Real command executed successfully.
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("real-zero");
    // Spy observed the unbounded timeout (0 = no timeout per docs).
    expect(spy).toHaveBeenCalledTimes(1);
    const options = spy.mock.calls[0]?.[1] as { timeoutMs?: number };
    expect(options?.timeoutMs).toBe(2_147_483_647);
  });
});
