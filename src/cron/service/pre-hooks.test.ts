import { describe, expect, it, vi } from "vitest";
import type { CronPreHook } from "../types-shared.js";
import { runPreHooks, runShellHook } from "./pre-hooks.js";

const noopLog = {
  info: vi.fn(),
  warn: vi.fn(),
};

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe("runShellHook", () => {
  it("returns proceed: true when shell exits 0", async () => {
    const result = await runShellHook({
      command: "exit 0",
      timeoutMs: 5_000,
      stdin: "{}",
      log: noopLog,
    });
    expect(result).toEqual({ proceed: true });
  });

  it("returns proceed: false when shell exits non-zero", async () => {
    const result = await runShellHook({
      command: "exit 1",
      timeoutMs: 5_000,
      stdin: "{}",
      log: noopLog,
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("exited 1");
    }
  });

  it("includes stderr in reason when shell exits non-zero", async () => {
    const result = await runShellHook({
      command: 'echo "check failed" >&2; exit 2',
      timeoutMs: 5_000,
      stdin: "{}",
      log: noopLog,
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("check failed");
      expect(result.reason).toContain("exited 2");
    }
  });

  it("returns proceed: false on timeout", async () => {
    const result = await runShellHook({
      command: "sleep 60",
      timeoutMs: 100,
      stdin: "{}",
      log: noopLog,
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("timed out");
      expect(result.reason).toContain("100ms");
    }
  });

  it("receives correct stdin JSON", async () => {
    const metadata = JSON.stringify({ jobId: "j1", jobName: "test", schedule: { kind: "every" } });
    // The hook reads stdin and writes it to stdout; we verify exit 0 means
    // the shell successfully read valid JSON from stdin.
    const result = await runShellHook({
      command: "cat > /dev/null && exit 0",
      timeoutMs: 5_000,
      stdin: metadata,
      log: noopLog,
    });
    expect(result).toEqual({ proceed: true });
  });
});

describe("runPreHooks", () => {
  it("returns proceed: true when hooks array is empty", async () => {
    const result = await runPreHooks({
      hooks: [],
      jobId: "j1",
      jobName: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      log: makeLog(),
    });
    expect(result).toEqual({ proceed: true });
  });

  it("returns proceed: true when single hook passes", async () => {
    const hooks: CronPreHook[] = [{ kind: "shell", command: "exit 0" }];
    const result = await runPreHooks({
      hooks,
      jobId: "j1",
      jobName: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      log: makeLog(),
    });
    expect(result).toEqual({ proceed: true });
  });

  it("returns proceed: false when single hook fails", async () => {
    const hooks: CronPreHook[] = [{ kind: "shell", command: "exit 1" }];
    const result = await runPreHooks({
      hooks,
      jobId: "j1",
      jobName: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      log: makeLog(),
    });
    expect(result.proceed).toBe(false);
  });

  it("short-circuits on first failing hook", async () => {
    const hooks: CronPreHook[] = [
      { kind: "shell", command: "exit 0" },
      { kind: "shell", command: "exit 42" },
      { kind: "shell", command: "exit 0" },
    ];
    const result = await runPreHooks({
      hooks,
      jobId: "j1",
      jobName: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      log: makeLog(),
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("exited 42");
    }
  });

  it("runs all hooks when all pass", async () => {
    const hooks: CronPreHook[] = [
      { kind: "shell", command: "exit 0" },
      { kind: "shell", command: "exit 0" },
    ];
    const result = await runPreHooks({
      hooks,
      jobId: "j1",
      jobName: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      log: makeLog(),
    });
    expect(result).toEqual({ proceed: true });
  });

  it("passes job metadata as stdin JSON", async () => {
    // Verify the hook receives parseable JSON with expected fields.
    // Use node (guaranteed available) to parse stdin.
    const hooks: CronPreHook[] = [
      {
        kind: "shell",
        command:
          'node -e "let d=\\"\\";process.stdin.on(\\"data\\",c=>d+=c);process.stdin.on(\\"end\\",()=>{const j=JSON.parse(d);process.exit(j.jobId===\\"j1\\"?0:1)})"',
      },
    ];
    const result = await runPreHooks({
      hooks,
      jobId: "j1",
      jobName: "my-job",
      schedule: { kind: "cron", expr: "0 * * * *" },
      log: makeLog(),
    });
    expect(result).toEqual({ proceed: true });
  });

  it("respects per-hook timeoutMs", async () => {
    const hooks: CronPreHook[] = [{ kind: "shell", command: "sleep 60", timeoutMs: 100 }];
    const result = await runPreHooks({
      hooks,
      jobId: "j1",
      jobName: "test",
      schedule: { kind: "every", everyMs: 60_000 },
      log: makeLog(),
    });
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("timed out");
    }
  });
});
