import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer.js";

function createNoopLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeExecJob(
  overrides: Partial<CronJob> & {
    command: string;
    shell?: string;
    timeoutSeconds?: number;
    env?: Record<string, string>;
  },
): CronJob {
  const { command, shell, timeoutSeconds, env, ...rest } = overrides;
  return {
    id: "test-exec-job",
    name: "test exec job",
    enabled: true,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    schedule: { kind: "cron", expr: "0 3 * * *" },
    sessionTarget: "isolated",
    payload: { kind: "exec", command, shell, timeoutSeconds, env },
    state: {},
    ...rest,
  } as CronJob;
}

function createState() {
  return createCronServiceState({
    cronEnabled: true,
    storePath: "/tmp/test-cron-exec.json",
    log: createNoopLogger() as never,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
  });
}

/**
 * Tests for payload.kind="exec" in executeJobCore.
 * Spawns real child processes — each exits immediately (fast).
 */
describe("executeJobCore — exec payload", () => {
  it("returns status ok for exit code 0", async () => {
    const state = createState();
    const job = makeExecJob({ command: "exit 0" });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
  });

  it("returns status error for non-zero exit code", async () => {
    const state = createState();
    const job = makeExecJob({ command: "exit 1" });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/exit code 1/);
  });

  it("captures stdout as summary", async () => {
    const state = createState();
    const job = makeExecJob({ command: "echo hello-from-exec" });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hello-from-exec");
  });

  it("captures stderr in summary on error", async () => {
    const state = createState();
    const job = makeExecJob({ command: "echo err-output >&2; exit 1" });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("error");
    expect(result.summary).toContain("err-output");
  });

  it("injects env vars into the process", async () => {
    const state = createState();
    const job = makeExecJob({
      command: "echo $MY_EXEC_TEST_VAR",
      env: { MY_EXEC_TEST_VAR: "injected-value-xyz" },
    });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("injected-value-xyz");
  });

  it("times out and returns error when timeoutSeconds exceeded", async () => {
    const state = createState();
    const job = makeExecJob({ command: "sleep 60", timeoutSeconds: 1 });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/timed out/i);
  }, 10_000);

  it("aborts cleanly when abortSignal fires", async () => {
    const state = createState();
    const job = makeExecJob({ command: "sleep 60" });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await executeJobCore(state, job, controller.signal);

    expect(result.status).toBe("error");
    expect(result.error).toMatch(/abort/i);
  }, 10_000);

  it("returns error for command that does not exist", async () => {
    const state = createState();
    const job = makeExecJob({ command: "this-command-definitely-does-not-exist-xyz-abc" });

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("error");
  });
});

describe("exec payload — agentTurn guard still rejects unknown kinds", () => {
  it("returns skipped for unknown payload kind", async () => {
    const state = createState();
    const job = {
      ...makeExecJob({ command: "echo ok" }),
      payload: { kind: "unknown-future-kind" } as never,
    };

    const result = await executeJobCore(state, job);

    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/agentTurn/);
  });
});
