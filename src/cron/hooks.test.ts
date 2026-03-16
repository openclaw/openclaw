// Authored by: cc (Claude Code) | 2026-03-13
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CronConfig } from "../config/types.cron.js";
import { isValidJobHookPath, loadHookEntries, runCronHooks } from "./hooks.js";
import type { CronHookContext } from "./hooks.js";
import type { CronJob } from "./types.js";

function stubJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "test-job",
    name: "Test Job",
    agentId: "test-agent",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  } as CronJob;
}

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCtx(
  hookPoint: "beforeRun" | "afterComplete" | "onFailure" | "afterRun",
  payload: CronHookContext["payload"] = { kind: "agentTurn", message: "hello" },
): CronHookContext {
  return {
    hookPoint,
    workflow: "cron",
    job: {
      id: "test-job",
      name: "Test Job",
      agentId: "test-agent",
      schedule: { kind: "every", everyMs: 60_000 },
    },
    payload,
    meta: {},
    log: noopLog,
  };
}

describe("loadHookEntries", () => {
  it("returns empty when no hooks configured", () => {
    const entries = loadHookEntries("beforeRun", undefined, stubJob());
    expect(entries).toEqual([]);
  });

  it("returns empty when cronConfig has no hooks", () => {
    const config: CronConfig = { enabled: true };
    const entries = loadHookEntries("beforeRun", config, stubJob());
    expect(entries).toEqual([]);
  });

  it("loads global hook entries from cronConfig", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [{ script: "hooks/a.cjs", priority: 5 }, { script: "hooks/b.cjs" }],
      },
    };
    const entries = loadHookEntries("beforeRun", config, stubJob());
    expect(entries).toHaveLength(2);
    expect(entries[0].script).toBe("hooks/a.cjs");
    expect(entries[0].priority).toBe(5);
    expect(entries[1].script).toBe("hooks/b.cjs");
    expect(entries[1].priority).toBe(10);
  });

  it("loads per-job hook entries", () => {
    const job = stubJob({
      hooks: { afterComplete: ["hooks/job-hook.cjs"] },
    });
    const entries = loadHookEntries("afterComplete", undefined, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/job-hook.cjs");
    expect(entries[0].priority).toBe(10);
  });

  it("merges global and per-job entries sorted by priority", () => {
    const config: CronConfig = {
      hooks: {
        afterRun: [{ script: "hooks/global.cjs", priority: 20 }],
      },
    };
    const job = stubJob({
      hooks: { afterRun: ["hooks/job.cjs"] },
    });
    const entries = loadHookEntries("afterRun", config, job);
    expect(entries).toHaveLength(2);
    // Per-job default priority (10) < global priority (20), so job entry first.
    expect(entries[0].script).toBe("hooks/job.cjs");
    expect(entries[1].script).toBe("hooks/global.cjs");
  });

  it("skips global hooks when skipGlobal includes the hook point", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [{ script: "hooks/global.cjs" }],
      },
    };
    const job = stubJob({
      hooks: {
        beforeRun: ["hooks/job.cjs"],
        skipGlobal: ["beforeRun"],
      },
    });
    const entries = loadHookEntries("beforeRun", config, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/job.cjs");
  });

  it("filters by jobId", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [
          { script: "hooks/filtered.cjs", filter: { jobId: ["other-job"] } },
          { script: "hooks/match.cjs", filter: { jobId: ["test-job"] } },
        ],
      },
    };
    const entries = loadHookEntries("beforeRun", config, stubJob());
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/match.cjs");
  });

  it("filters by agentId", () => {
    const config: CronConfig = {
      hooks: {
        onFailure: [
          { script: "hooks/wrong-agent.cjs", filter: { agentId: ["other-agent"] } },
          { script: "hooks/right-agent.cjs", filter: { agentId: ["test-agent"] } },
        ],
      },
    };
    const entries = loadHookEntries("onFailure", config, stubJob());
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/right-agent.cjs");
  });

  it("excludes hooks with agentId filter when job has no agentId", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [
          { script: "hooks/agent-only.cjs", filter: { agentId: ["some-agent"] } },
          { script: "hooks/no-filter.cjs" },
        ],
      },
    };
    const job = stubJob({ agentId: undefined });
    const entries = loadHookEntries("beforeRun", config, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/no-filter.cjs");
  });

  it("filters by workflow", () => {
    const config: CronConfig = {
      hooks: {
        afterRun: [
          { script: "hooks/pipeline-only.cjs", filter: { workflow: ["pipeline"] } },
          { script: "hooks/cron-only.cjs", filter: { workflow: ["cron"] } },
          { script: "hooks/all.cjs" },
        ],
      },
    };
    const entries = loadHookEntries("afterRun", config, stubJob(), "cron");
    expect(entries).toHaveLength(2);
    expect(entries[0].script).toBe("hooks/cron-only.cjs");
    expect(entries[1].script).toBe("hooks/all.cjs");
  });

  it("excludes all hooks when workflow does not match", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [{ script: "hooks/pipeline-only.cjs", filter: { workflow: ["pipeline"] } }],
      },
    };
    const entries = loadHookEntries("beforeRun", config, stubJob(), "cron");
    expect(entries).toEqual([]);
  });

  it("filters by jobName (case-insensitive substring)", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [
          { script: "hooks/daily-only.cjs", filter: { jobName: ["daily"] } },
          { script: "hooks/all.cjs" },
        ],
      },
    };
    const job = stubJob({ name: "Daily Backup" });
    const entries = loadHookEntries("beforeRun", config, job);
    expect(entries).toHaveLength(2);
    expect(entries[0].script).toBe("hooks/daily-only.cjs");
  });

  it("excludes hooks when jobName does not match", () => {
    const config: CronConfig = {
      hooks: {
        beforeRun: [{ script: "hooks/daily-only.cjs", filter: { jobName: ["weekly"] } }],
      },
    };
    const job = stubJob({ name: "Daily Backup" });
    const entries = loadHookEntries("beforeRun", config, job);
    expect(entries).toEqual([]);
  });

  it("rejects per-job hooks with path traversal", () => {
    const job = stubJob({
      hooks: {
        beforeRun: ["../../secrets.env", "../../../etc/passwd", "hooks/valid.cjs"],
      },
    });
    const entries = loadHookEntries("beforeRun", undefined, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/valid.cjs");
  });

  it("rejects per-job hooks with absolute paths", () => {
    const job = stubJob({
      hooks: { beforeRun: ["/etc/passwd", "hooks/safe.cjs"] },
    });
    const entries = loadHookEntries("beforeRun", undefined, job);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("hooks/safe.cjs");
  });
});

describe("isValidJobHookPath", () => {
  it("accepts workspace-relative paths", () => {
    expect(isValidJobHookPath("hooks/audit.cjs")).toBe(true);
    expect(isValidJobHookPath("workspace/scripts/hooks/alert.cjs")).toBe(true);
  });

  it("rejects absolute paths", () => {
    expect(isValidJobHookPath("/etc/passwd")).toBe(false);
    expect(isValidJobHookPath("/home/user/hook.cjs")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidJobHookPath("../../secrets.env")).toBe(false);
    expect(isValidJobHookPath("../hook.cjs")).toBe(false);
    expect(isValidJobHookPath("hooks/../../etc/passwd")).toBe(false);
  });

  it("rejects URL-scheme specifiers", () => {
    expect(isValidJobHookPath("npm:some-package")).toBe(false);
    expect(isValidJobHookPath("node:fs")).toBe(false);
    expect(isValidJobHookPath("https://example.com/hook.js")).toBe(false);
    expect(isValidJobHookPath("data:text/javascript,export default()=>{}")).toBe(false);
  });
});

/**
 * Creates a data-URI module that exports the given function body as default.
 * This avoids filesystem mocking while giving us real dynamic-import hooks.
 * NOTE: data: URI imports require Node.js — this will not work in Bun or edge runtimes.
 */
function inlineHook(body: string): string {
  const code = `export default ${body}`;
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

describe("runCronHooks", () => {
  it("returns not-aborted for empty entries", async () => {
    const result = await runCronHooks("beforeRun", makeCtx("beforeRun"), []);
    expect(result).toEqual({ aborted: false });
  });

  it("returns not-aborted for empty afterComplete entries", async () => {
    const result = await runCronHooks("afterComplete", makeCtx("afterComplete"), []);
    expect(result).toEqual({ aborted: false });
  });

  it("logs warning and continues when script module is not found", async () => {
    const ctx = makeCtx("afterRun");
    const entries = [{ script: "./nonexistent-hook-module-12345.cjs", priority: 10 }];
    const result = await runCronHooks("afterRun", ctx, entries);
    expect(result).toEqual({ aborted: false });
    expect(noopLog.warn).toHaveBeenCalled();
  });

  it("aborts when beforeRun hook returns { abort: true, reason }", async () => {
    const script = inlineHook(
      `async function(ctx) { return { abort: true, reason: "test abort" }; }`,
    );
    const entries = [{ script, priority: 10 }];
    const result = await runCronHooks("beforeRun", makeCtx("beforeRun"), entries);
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("test abort");
  });

  it("uses default reason when abort result omits reason", async () => {
    const script = inlineHook(`async function(ctx) { return { abort: true }; }`);
    const entries = [{ script, priority: 10 }];
    const result = await runCronHooks("beforeRun", makeCtx("beforeRun"), entries);
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("aborted by hook");
  });

  it("does not abort when hook returns { abort: false }", async () => {
    const script = inlineHook(`async function(ctx) { return { abort: false }; }`);
    const entries = [{ script, priority: 10 }];
    const result = await runCronHooks("beforeRun", makeCtx("beforeRun"), entries);
    expect(result.aborted).toBe(false);
  });

  it("ignores abort result from non-beforeRun hooks", async () => {
    const script = inlineHook(`async function(ctx) { return { abort: true, reason: "ignored" }; }`);
    const entries = [{ script, priority: 10 }];
    const result = await runCronHooks("afterRun", makeCtx("afterRun"), entries);
    expect(result.aborted).toBe(false);
  });

  it("exposes payload.kind to hook via ctx.payload", async () => {
    // Hook reads ctx.payload.kind and aborts only when it is "agentTurn".
    const script = inlineHook(
      `async function(ctx) { return ctx.payload.kind === "agentTurn" ? { abort: true, reason: "kind-check" } : {}; }`,
    );
    const entries = [{ script, priority: 10 }];
    const result = await runCronHooks(
      "beforeRun",
      makeCtx("beforeRun", { kind: "agentTurn", message: "hi" }),
      entries,
    );
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe("kind-check");
  });

  it("does not abort when payload.kind does not match hook condition", async () => {
    const script = inlineHook(
      `async function(ctx) { return ctx.payload.kind === "agentTurn" ? { abort: true } : {}; }`,
    );
    const entries = [{ script, priority: 10 }];
    // systemEvent payload — hook condition should not trigger abort.
    const result = await runCronHooks(
      "beforeRun",
      makeCtx("beforeRun", { kind: "systemEvent", text: "ping" }),
      entries,
    );
    expect(result.aborted).toBe(false);
  });

  it("exposes all payload fields to the hook", async () => {
    // Hook reads nested payload fields and signals via meta to verify they are accessible.
    const script = inlineHook(
      `async function(ctx) { ctx.meta.seenMessage = ctx.payload.message; }`,
    );
    const entries = [{ script, priority: 10 }];
    const ctx = makeCtx("afterRun", { kind: "agentTurn", message: "check-fields" });
    await runCronHooks("afterRun", ctx, entries);
    expect(ctx.meta.seenMessage).toBe("check-fields");
  });
});
