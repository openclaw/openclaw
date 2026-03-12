/**
 * Focused tests for the acpTurn cron payload kind.
 * Covers: creation/validation, normalize roundtrip, execution routing,
 * delivery defaults, and error behavior when ACP is unavailable.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";
import { CronService } from "./service.js";
import { assertSupportedJobSpec } from "./service/jobs.js";
import { executeJobCore } from "./service/timer.js";
import type { CronJob } from "./types.js";

// ---------- helpers ----------

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-acp-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function makeAcpJob(overrides?: Partial<CronJob>): CronJob {
  return {
    id: "acp-job-1",
    name: "ACP Codex Job",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "acpTurn", message: "run codex task", acpAgentId: "codex" },
    state: {},
    ...overrides,
  } as CronJob;
}

// Minimal CronServiceState-like object for executeJobCore testing
function makeState(opts?: {
  runIsolatedAgentJob?: (p: unknown) => Promise<unknown>;
  runAcpJob?: (p: unknown) => Promise<unknown>;
}) {
  return {
    deps: {
      nowMs: () => Date.now(),
      log: noopLogger,
      storePath: "/tmp/noop",
      cronEnabled: true,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: opts?.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" })),
      runAcpJob: opts?.runAcpJob,
    },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    storeLoadedAtMs: null,
    storeFileMtimeMs: null,
  } as never;
}

// ---------- types/validation ----------

describe("assertSupportedJobSpec — acpTurn", () => {
  it("accepts isolated + acpTurn", () => {
    expect(() =>
      assertSupportedJobSpec({
        sessionTarget: "isolated",
        payload: { kind: "acpTurn", message: "hello" },
      }),
    ).not.toThrow();
  });

  it("rejects main + acpTurn with the acpTurn-specific error", () => {
    // acpTurn check is first, so the error clearly says acpTurn requires isolated.
    expect(() =>
      assertSupportedJobSpec({
        sessionTarget: "main",
        payload: { kind: "acpTurn", message: "hello" },
      }),
    ).toThrow(/acpTurn.*isolated/i);
  });

  it("still rejects isolated + unknown kind", () => {
    expect(() =>
      assertSupportedJobSpec({
        sessionTarget: "isolated",
        payload: { kind: "unknownKind" } as never,
      }),
    ).toThrow();
  });
});

// ---------- normalize ----------

describe("normalizeCronJobCreate — acpTurn", () => {
  it("preserves acpTurn payload kind and fields", () => {
    const result = normalizeCronJobCreate({
      name: "codex nightly",
      schedule: { kind: "cron", expr: "0 2 * * *" },
      payload: {
        kind: "acpTurn",
        message: "run nightly analysis",
        acpAgentId: "codex",
        timeoutSeconds: 120,
      },
    });
    expect(result?.payload).toEqual({
      kind: "acpTurn",
      message: "run nightly analysis",
      acpAgentId: "codex",
      timeoutSeconds: 120,
    });
    expect(result?.sessionTarget).toBe("isolated");
  });

  it("normalizes case-insensitive kind 'acpturn' → 'acpTurn'", () => {
    const result = normalizeCronJobCreate({
      name: "acp job",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      payload: { kind: "acpturn", message: "test" },
    });
    expect(result?.payload?.kind).toBe("acpTurn");
  });

  it("auto-sets sessionTarget=isolated for acpTurn", () => {
    const result = normalizeCronJobCreate({
      name: "acp job",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      payload: { kind: "acpTurn", message: "run task" },
    });
    expect(result?.sessionTarget).toBe("isolated");
  });

  it("auto-sets delivery.mode=announce for acpTurn when delivery omitted", () => {
    const result = normalizeCronJobCreate({
      name: "acp job",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      payload: { kind: "acpTurn", message: "run task" },
    });
    expect((result?.delivery as { mode?: string })?.mode).toBe("announce");
  });

  it("rejects main + acpTurn in normalizeCronJobCreate (sessionTarget override rejected at creation)", () => {
    // normalizeCronJobCreate does not throw on its own — assertSupportedJobSpec is called in
    // createJob(). But the normalize step should still set sessionTarget=isolated for acpTurn.
    const result = normalizeCronJobCreate({
      name: "bad job",
      schedule: { kind: "cron", expr: "0 3 * * *" },
      sessionTarget: "main",
      payload: { kind: "acpTurn", message: "oops" },
    });
    // Normalizer should pass through the explicit sessionTarget=main unmodified (no coercion).
    // The validation error fires later in assertSupportedJobSpec / createJob.
    expect(result?.sessionTarget).toBe("main");
    expect(result?.payload?.kind).toBe("acpTurn");
  });
});

describe("normalizeCronJobPatch — acpTurn", () => {
  it("normalizes kind acpturn → acpTurn in patch", () => {
    const patch = normalizeCronJobPatch({ payload: { kind: "acpturn", message: "updated" } });
    expect(patch?.payload?.kind).toBe("acpTurn");
  });
});

// ---------- CronService integration — creation ----------

describe("CronService.add — acpTurn", () => {
  let storePath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const s = await makeStorePath();
    storePath = s.storePath;
    cleanup = s.cleanup;
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanup();
  });

  it("creates isolated acpTurn job successfully", async () => {
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    const job = await cron.add({
      name: "acp codex job",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "acpTurn", message: "run analysis", acpAgentId: "codex" },
    });
    expect(job.payload.kind).toBe("acpTurn");
    expect((job.payload as { acpAgentId?: string }).acpAgentId).toBe("codex");
    expect(job.sessionTarget).toBe("isolated");
    expect(job.enabled).toBe(true);
  });

  it("rejects main + acpTurn creation with clear error", async () => {
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    await cron.start();
    await expect(
      cron.add({
        name: "bad job",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "acpTurn", message: "oops" },
      }),
    ).rejects.toThrow(/acpTurn.*isolated/i);
  });
});

// ---------- executeJobCore — routing ----------

describe("executeJobCore — acpTurn routing", () => {
  it("calls runAcpJob for acpTurn payload", async () => {
    const runAcpJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
    }));
    const state = makeState({ runAcpJob });
    const job = makeAcpJob();
    const result = await executeJobCore(state, job);
    expect(runAcpJob).toHaveBeenCalledTimes(1);
    expect(runAcpJob).toHaveBeenCalledWith(
      expect.objectContaining({ job, message: "run codex task" }),
    );
    expect(result.status).toBe("ok");
  });

  it("does NOT call runIsolatedAgentJob for acpTurn payload", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const runAcpJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = makeState({ runIsolatedAgentJob, runAcpJob });
    await executeJobCore(state, makeAcpJob());
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(runAcpJob).toHaveBeenCalledTimes(1);
  });

  it("returns error when runAcpJob not configured and payload is acpTurn", async () => {
    const state = makeState({ runAcpJob: undefined });
    const result = await executeJobCore(state, makeAcpJob());
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/ACP backend unavailable/i);
  });

  it("still routes agentTurn via runIsolatedAgentJob (no regression)", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "ok" }));
    const runAcpJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = makeState({ runIsolatedAgentJob, runAcpJob });
    const agentTurnJob = makeAcpJob({
      payload: { kind: "agentTurn", message: "run agent task" },
    });
    await executeJobCore(state, agentTurnJob);
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(runAcpJob).not.toHaveBeenCalled();
  });

  it("returns skipped error for unsupported isolated payload kind", async () => {
    const state = makeState({ runAcpJob: undefined });
    const job = makeAcpJob({ payload: { kind: "unknownKind" as never, message: "x" } });
    const result = await executeJobCore(state, job);
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/agentTurn.*acpTurn/i);
  });
});

// ---------- run-acp.ts — ACP policy check and runtime dispatch ----------

describe("runCronAcpTurn — ACP policy enforcement", () => {
  it("returns explicit error when ACP is disabled by policy", async () => {
    const { runCronAcpTurn } = await import("./isolated-agent/run-acp.js");
    const job = makeAcpJob();
    const result = await runCronAcpTurn({
      cfg: { acp: { enabled: false } } as never,
      deps: {} as never,
      job,
      message: "run task",
      sessionKey: "cron:test",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/ACP.*disabled/i);
  });

  it("returns error for non-acpTurn payload kind", async () => {
    const { runCronAcpTurn } = await import("./isolated-agent/run-acp.js");
    const job = makeAcpJob({ payload: { kind: "agentTurn", message: "oops" } });
    const result = await runCronAcpTurn({
      cfg: {} as never,
      deps: {} as never,
      job,
      message: "oops",
      sessionKey: "cron:test",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/expected acpTurn/i);
  });

  it("returns error when acpAgentId is not allowed by policy", async () => {
    const { runCronAcpTurn } = await import("./isolated-agent/run-acp.js");
    const job = makeAcpJob({
      payload: { kind: "acpTurn", message: "run task", acpAgentId: "forbidden-agent" },
    });
    // allowedAgents restricts to only "claude"
    const result = await runCronAcpTurn({
      cfg: { acp: { enabled: true, allowedAgents: ["claude"] } } as never,
      deps: {} as never,
      job,
      message: "run task",
      sessionKey: "cron:test",
    });
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/not allowed/i);
  });

  it("returns error when ACP session init fails (backend not configured)", async () => {
    // ACP is enabled by policy but no backend runtime is registered.
    // initializeSession will throw — we expect a clear error, not a crash.
    const { runCronAcpTurn } = await import("./isolated-agent/run-acp.js");
    const { __testing } = await import("../acp/control-plane/manager.js");
    __testing.resetAcpSessionManagerForTests();

    const job = makeAcpJob();
    const result = await runCronAcpTurn({
      // ACP is enabled but no backend is configured in cfg
      cfg: { acp: { enabled: true } } as never,
      deps: {} as never,
      job,
      message: "run task",
      sessionKey: "cron:test",
    });
    expect(result.status).toBe("error");
    // Should contain a meaningful error about session init / backend
    expect(result.error).toMatch(/ACP session init failed|backend|not found/i);
  });
});
