import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as jobPrecheck from "../../cron/job-precheck.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../../cron/service.test-harness.js";
import { createCronServiceState as createCronServiceStateBase } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import { loadCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import type { CronJob } from "../../cron/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import * as taskExecutor from "../../tasks/task-executor.js";
import { findTaskByRunId, listTaskRecordsUnsorted } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { advanceCronActiveJobGeneration } from "../active-jobs.js";
import { start, stop } from "./ops-lifecycle.js";
import { add as addJob, update as updateJob } from "./ops-mutations.js";
import { status as cronStatus } from "./ops-read.js";
import { run } from "./ops-run.js";
import { executeJobCore } from "./timer-execution.js";
import {
  createDueCommandJob,
  createDueIsolatedAgentJob,
  createDueMainJob,
  createDueScriptJob,
  findCronRunByBaseRunId,
} from "./timer.seam.test-support.js";

const now = Date.parse("2026-03-23T12:00:00.000Z");

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-timer-seam",
});

type StateDeps = Parameters<typeof createCronServiceStateBase>[0];
type DefaultDeps =
  | "scheduler"
  | "cronEnabled"
  | "log"
  | "enqueueSystemEvent"
  | "requestHeartbeat"
  | "runIsolatedAgentJob";
function createCronServiceState(
  params: Omit<StateDeps, DefaultDeps> & Partial<Pick<StateDeps, DefaultDeps>>,
): ReturnType<typeof createCronServiceStateBase> {
  return createCronServiceStateBase({
    defaultAgentId: "main",
    nowMs: () => now,
    scheduler: createTestGatewayScheduler(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    cronEnabled: true,
    log: logger,
    ...params,
  });
}

async function runStoredScript(
  job: CronJob,
  outcome: Awaited<ReturnType<NonNullable<StateDeps["runScriptJob"]>>>,
) {
  const { storePath } = await makeStorePath();
  await writeCronStoreSnapshot({ storePath, jobs: [job] });
  const state = createCronServiceState({
    storePath,
    cronConfig: { triggers: { enabled: true } },
    runScriptJob: vi.fn(async () => outcome),
  });
  await onTimer(state);
  return (await loadCronStore(storePath)).jobs[0];
}

describe("cron service timer seam coverage", () => {
  it("startup ignores stale event schedule slots", async () => {
    const { storePath } = await makeStorePath();
    const schedules: CronJob["schedule"][] = [
      { kind: "on-exit", command: "true" },
      { kind: "stream", command: ["true"], mode: "line" },
    ];
    const jobs = schedules.map((schedule) => {
      const job = createDueMainJob({ now, wakeMode: "next-heartbeat" });
      job.id = `stale-${schedule.kind}`;
      job.schedule = schedule;
      job.state = {
        nextRunAtMs: now - 1,
        startupCatchupAtMs: now - 1,
        pacedNextRunAtMs: now - 1,
        forcePreservedNextRunAtMs: now - 1,
      };
      return job;
    });
    await writeCronStoreSnapshot({ storePath, jobs });
    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      storePath,
      enqueueSystemEvent,
    });

    try {
      await start(state);
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      const stored = await loadCronStore(storePath);
      expect(stored.jobs).toHaveLength(2);
      for (const job of stored.jobs) {
        expect(job.enabled).toBe(true);
        expect(job.state.nextRunAtMs).toBeUndefined();
        expect(job.state.startupCatchupAtMs).toBeUndefined();
        expect(job.state.pacedNextRunAtMs).toBeUndefined();
        expect(job.state.forcePreservedNextRunAtMs).toBeUndefined();
        await expect(run(state, job.id, "due")).resolves.toEqual({
          ok: true,
          ran: false,
          reason: "not-due",
        });
        await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      }
      expect(enqueueSystemEvent).toHaveBeenCalledTimes(2);
    } finally {
      stop(state);
    }
  });

  it("persists the next schedule and hands off next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();

    const jobWithoutExplicitOwner = createDueMainJob({ now, wakeMode: "next-heartbeat" });
    delete jobWithoutExplicitOwner.sessionKey;
    await writeCronStoreSnapshot({ storePath, jobs: [jobWithoutExplicitOwner] });

    const state = createCronServiceState({
      storePath,
      defaultAgentId: "stale-default",
      resolveDefaultAgentId: () => "ops",
      enqueueSystemEvent,
      requestHeartbeat,
    });

    await onTimer(state);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("heartbeat seam tick", {
      agentId: "ops",
      contextKey: "cron:main-heartbeat-job",
    });
    expect(requestHeartbeat).toHaveBeenCalledWith({
      source: "cron",
      intent: "event",
      reason: "cron:main-heartbeat-job",
      agentId: "ops",
      heartbeat: { target: "last" },
    });

    const persisted = await loadCronStore(storePath);
    const job = persisted.jobs[0];
    if (!job) {
      throw new Error("expected persisted heartbeat cron job");
    }
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.runningAtMs).toBeUndefined();
    expect(job.state.nextRunAtMs).toBe(now + 60_000);
    const task = findCronRunByBaseRunId(storePath, `cron:main-heartbeat-job:${now}`);
    if (!task) {
      throw new Error("expected cron task ledger record");
    }
    expect(task.jobId).toBe("main-heartbeat-job");
    expect(task.agentId).toBe("ops");
    expect(task.sessionKey).toBeUndefined();
    expect(task.runId).toMatch(new RegExp(`^cron:main-heartbeat-job:${now}:`));
    expect(task.status).toBe("succeeded");
    expect(task.startedAt).toBe(now);
    expect(task.lastEventAt).toBe(now);
    expect(task.endedAt).toBe(now);
    expect(task.cleanupAfter).toBe(now + 7 * 24 * 60 * 60_000);

    expect((await cronStatus(state)).nextWakeAtMs).toBe(now + 60_000);
  });

  it("does not dispatch payload work when trigger evaluation resolves after cancellation", async () => {
    const { storePath } = await makeStorePath();
    const evaluation = createDeferred<{
      kind: "evaluated";
      fire: true;
      state: { revision: number };
    }>();
    const evaluateCronTrigger = vi.fn(() => evaluation.promise);
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const runCommandJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const runScriptJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const runIsolatedAgentJob = vi.fn(() => Promise.resolve({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: true } },
      enqueueSystemEvent,
      requestHeartbeat,
      evaluateCronTrigger,
      runCommandJob,
      runScriptJob,
      runIsolatedAgentJob,
    });
    const job: CronJob = {
      ...createDueCommandJob({ now }),
      trigger: { script: "json({ fire: true })" },
    };
    const controller = new AbortController();

    const result = executeJobCore(state, job, controller.signal);
    try {
      expect(evaluateCronTrigger).toHaveBeenCalledOnce();
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });

      await expect(result).resolves.toMatchObject({ status: "error" });
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(runCommandJob).not.toHaveBeenCalled();
      expect(runScriptJob).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      // Abort before releasing evaluation so failed assertions cannot start payload work.
      controller.abort(new Error("operator cancelled the scheduled run"));
      evaluation.resolve({ kind: "evaluated", fire: true, state: { revision: 2 } });
      await result;
    }
  });

  it.each([{ kind: "stream", command: ["true"] }] satisfies CronJob["schedule"][])(
    "keeps $kind jobs event-driven after a next-run state update",
    async (schedule) => {
      const { storePath } = await makeStorePath();
      const runPayload = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath,
        runIsolatedAgentJob: runPayload,
        runCommandJob: runPayload,
      });

      try {
        const job = await addJob(state, {
          agentId: "finn",
          name: "event command",
          enabled: true,
          schedule,
          sessionTarget: "isolated",
          wakeMode: "now",
          payload:
            schedule.kind === "stream"
              ? { kind: "agentTurn", message: "Handle stream events" }
              : { kind: "command", argv: ["true"] },
        });
        await updateJob(state, job.id, { state: { nextRunAtMs: now - 1 } });
        await onTimer(state);
        expect(runPayload).not.toHaveBeenCalled();
        await expect(cronStatus(state)).resolves.toMatchObject({
          enabled: true,
          jobs: 1,
          nextWakeAtMs: null,
        });
        await expect(run(state, job.id, "due")).resolves.toEqual({
          ok: true,
          ran: false,
          reason: "not-due",
        });
        await expect(run(state, job.id, "force")).resolves.toEqual({ ok: true, ran: true });
        expect(runPayload).toHaveBeenCalledOnce();
      } finally {
        stop(state);
      }
    },
  );

  it("records an execution error when script payloads are disabled", async () => {
    const { storePath } = await makeStorePath();
    const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: false } },
      runScriptJob,
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("the operator set cron.triggers.enabled: false"),
    });
    expect(runScriptJob).not.toHaveBeenCalled();
  });

  it("blocks a host-shell precheck when cron.triggers.enabled is explicitly false", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      // triggers disabled: unattended host-shell execution must be denied.
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const job: CronJob = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
      precheck: { kind: "exec", command: "exit 2" },
    };

    const result = await executeJobCore(state, job);

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringMatching(/cron\.triggers\.enabled/),
    });
    // The gate must short-circuit before any agent payload runs.
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
  });

  it("allows host-shell precheck when cron.triggers.enabled is absent (default-on)", async () => {
    // ClawSweeper P1: match main trigger/script default-on (only explicit false disables).
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-17T08:00:00.000Z");
    const spy = vi.spyOn(jobPrecheck, "runCronJobPrecheck").mockResolvedValue({
      decision: "skip",
      reason: "precheck-no-work",
      exitCode: 2,
      stdout: "NO_WORK\n",
      stderr: "",
    } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>);
    try {
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        // no cronConfig.triggers — absent means enabled
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const job: CronJob = {
        ...createDueMainJob({ now, wakeMode: "now" }),
        payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
        precheck: { kind: "exec", command: "exit 2" },
      };
      const result = await executeJobCore(state, job);
      expect(spy).toHaveBeenCalled();
      const authz = spy.mock.calls[0]?.[1]?.authz as { triggersEnabled?: boolean } | undefined;
      expect(authz?.triggersEnabled).toBe(true);
      expect(result).toMatchObject({ status: "skipped", error: "precheck-no-work" });
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("allows a host-shell precheck to skip the payload when triggers are enabled", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    // This path needs triggers + a permitting exec security (host approvals often
    // default allowlist/full). Policy denies without shell spawn are covered in
    // job-precheck.test.ts. Here we prove no-work precheck skips the payload.
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      ...createDueMainJob({ now, wakeMode: "now" }),
      // exit code 2 = NO_WORK under the default exit-code contract.
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
      precheck: { kind: "exec", command: "exit 2" },
    };

    const result = await executeJobCore(state, job);
    const agent = state.deps.runIsolatedAgentJob as ReturnType<typeof vi.fn>;

    // Host exec policy may deny without spawning; either path must not run payload/agent.
    if (result.status === "error") {
      expect(String(result.error)).toContain("precheck-policy-denied");
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({
      status: "skipped",
      error: "precheck-no-work",
      summary: "precheck-no-work",
    });
    // No payload/model side effect on a no-work skip.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });

  it("persists precheck-skipped-error through onTimer when onError=skip (distinct from no-work)", async () => {
    // ClawSweeper P2: failed probes with onError=skip must not look like quiet no-work.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-15T07:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const spy = vi.spyOn(jobPrecheck, "runCronJobPrecheck").mockResolvedValue({
      decision: "skip",
      reason: "precheck-skipped-error",
      exitCode: 7,
      stdout: "",
      stderr: "boom",
    } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>);
    try {
      const job: CronJob = {
        ...createDueIsolatedAgentJob({ now }),
        id: "precheck-skipped-error-persist",
        payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] },
        precheck: { kind: "exec", command: "exit 7", onError: "skip" },
      };
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });

      await onTimer(state);

      const stored = await loadCronStore(storePath);
      const persisted = stored.jobs.find((entry) => entry.id === "precheck-skipped-error-persist");
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(persisted?.state.lastStatus).toBe("skipped");
      expect(persisted?.state.lastError ?? "").toContain("precheck-skipped-error");
      expect(persisted?.state.lastError ?? "").not.toContain("precheck-no-work");
    } finally {
      spy.mockRestore();
    }
  });

  it("persists precheck-no-work through onTimer without an agent turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:00:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const job: CronJob = {
      ...createDueIsolatedAgentJob({ now }),
      id: "precheck-no-work-persist",
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] as const },
      precheck: { kind: "exec", command: "exit 2" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      cronConfig: { triggers: { enabled: true } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    const persisted = stored.jobs.find((entry) => entry.id === "precheck-no-work-persist");
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    // Policy-deny vs no-work both prove zero agent turns; prefer no-work when allowed.
    if (persisted?.state.lastStatus === "error") {
      expect(persisted.state.lastError ?? "").toContain("precheck-policy-denied");
      return;
    }
    expect(persisted?.state.lastStatus).toBe("skipped");
    expect(persisted?.state.lastError ?? "").toContain("precheck-no-work");
    expect(persisted?.state.consecutiveSkipped ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("passes canonical effective cron owner into precheck authz (sessionKey-owned)", async () => {
    // ClawSweeper P1: agent-less jobs owned via sessionKey must not pass undefined
    // job.agentId into exec approvals (generic default entry). Timer must resolve
    // resolveCronJobEffectiveAgentId and forward that owner for tools + approvals.
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-08-15T04:00:00.000Z");
    const spy = vi.spyOn(jobPrecheck, "runCronJobPrecheck").mockResolvedValue({
      decision: "skip",
      reason: "precheck-no-work",
      exitCode: 2,
      stdout: "NO_WORK\n",
      stderr: "",
    } as Awaited<ReturnType<typeof jobPrecheck.runCronJobPrecheck>>);
    try {
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        defaultAgentId: "main",
      });
      const job: CronJob = {
        ...createDueMainJob({ now, wakeMode: "now" }),
        // Explicit agent-less: ownership comes from sessionKey agent:ops:...
        agentId: undefined,
        sessionKey: "agent:ops:main",
        payload: {
          ...createDueMainJob({ now, wakeMode: "now" }).payload,
          toolsAllow: ["*"],
        },
        precheck: { kind: "exec", command: "exit 2" },
      };
      const result = await executeJobCore(state, job);
      expect(spy).toHaveBeenCalled();
      const authz = spy.mock.calls[0]?.[1]?.authz as { agentId?: string } | undefined;
      expect(authz?.agentId).toBe("ops");
      expect(result).toMatchObject({ status: "skipped", error: "precheck-no-work" });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["systemEvent", "heartbeat"] as const)(
    "denies host-shell precheck for capless %s payload (no toolsAllow)",
    async (kind) => {
      // ClawSweeper P1: non-tool payloads used to keep toolsAllow undefined, which
      // the precheck runner treated as unrestricted host exec. Fail closed instead.
      const { storePath } = await makeStorePath();
      const now = Date.parse("2026-08-17T04:00:00.000Z");
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const state = createCronServiceState({
        storePath,
        cronEnabled: true,
        cronConfig: { triggers: { enabled: true } },
        log: logger,
        nowMs: () => now,
        enqueueSystemEvent,
        requestHeartbeat,
        runIsolatedAgentJob,
      });
      const base =
        kind === "heartbeat"
          ? {
              ...createDueMainJob({ now, wakeMode: "next-heartbeat" }),
              payload: { kind: "heartbeat" as const },
            }
          : createDueMainJob({ now, wakeMode: "now" });
      const job: CronJob = {
        ...base,
        id: `precheck-capless-${kind}`,
        // Explicitly capless — no toolsAllow stamped on payload
        payload: { ...base.payload },
        precheck: { kind: "exec", command: "echo should-not-run; exit 0" },
      };
      Reflect.deleteProperty(job.payload, "toolsAllow");

      const result = await executeJobCore(state, job);
      expect(result.status).toBe("error");
      expect(result).toMatchObject({ status: "error" });
      expect(String("error" in result ? result.error : "")).toMatch(
        /toolsAllow|precheck-policy-denied/,
      );
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
    },
  );

  it("persists precheck-policy-denied through onTimer without an agent turn", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-07-25T12:30:00.000Z");
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const job: CronJob = {
      ...createDueIsolatedAgentJob({ now }),
      id: "precheck-denied-persist",
      payload: { ...createDueIsolatedAgentJob({ now }).payload, toolsAllow: ["*"] },
      precheck: { kind: "exec", command: "exit 0" },
    };
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      // triggers off => shared host-shell admission denies before spawn
      cronConfig: { triggers: { enabled: false } },
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const stored = await loadCronStore(storePath);
    const persisted = stored.jobs.find((entry) => entry.id === "precheck-denied-persist");
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(persisted?.state.lastStatus).toBe("error");
    expect(persisted?.state.lastError ?? "").toMatch(
      /precheck-policy-denied|cron\.triggers\.enabled/,
    );
  });

  it.each([
    { target: "main", notify: "queue changed", wake: "next-heartbeat" },
    { target: "isolated", notify: "queue changed", wake: "now" },
    { target: "main", notify: undefined, wake: "now" },
  ] as const)(
    "routes $target script side effects (notify=$notify, wake=$wake)",
    async ({ target, notify, wake }) => {
      const { storePath } = await makeStorePath();
      const sessionKey = "agent:ops:telegram:group:42:topic:77";
      const sessionStorePath = path.join(path.dirname(path.dirname(storePath)), "sessions.json");
      const deliveryContext = {
        channel: "telegram",
        to: "telegram:42",
        accountId: "ops-bot",
        threadId: 77,
      };
      await upsertSessionEntryCore(
        { storePath: sessionStorePath, sessionKey },
        {
          sessionId: "ops-telegram-session",
          updatedAt: now,
          delivery: normalizeSessionDeliveryState({ context: deliveryContext }),
        },
      );
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const state = createCronServiceState({
        storePath,
        cronConfig: { triggers: { enabled: true } },
        resolveDefaultAgentId: () => "other",
        resolveSessionStorePath: () => sessionStorePath,
        enqueueSystemEvent,
        requestHeartbeat,
        runScriptJob: vi.fn(async () => ({ status: "ok" as const, notify, wake })),
      });
      const job = {
        ...createDueScriptJob({ now, sessionTarget: target }),
        agentId: undefined,
        sessionKey,
      };
      await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
      expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
        notify ?? "script job script job completed",
        {
          agentId: "ops",
          contextKey: `cron:script-job:${target === "main" && notify ? "script" : "script-wake"}`,
          ...(target === "main" ? { deliveryContext } : {}),
        },
      );
      if (wake) {
        expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
          source: wake === "now" ? "notifications-event" : "cron",
          intent: wake === "now" ? "immediate" : "event",
          reason: wake === "now" ? "wake" : "cron:script-job:script",
          agentId: "ops",
        });
      } else {
        expect(requestHeartbeat).not.toHaveBeenCalled();
      }
    },
  );

  it("delivers nothing and enqueues nothing when notify and wake are absent", async () => {
    const { storePath } = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeat = vi.fn();
    const resolveDefaultAgentId = vi.fn(() => undefined);
    const state = createCronServiceState({
      storePath,
      defaultAgentId: undefined,
      resolveDefaultAgentId,
      cronConfig: { triggers: { enabled: true } },
      enqueueSystemEvent,
      requestHeartbeat,
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        delivered: false,
        deliveryAttempted: false,
      })),
    });

    await expect(
      executeJobCore(state, {
        ...createDueScriptJob({ now, sessionTarget: "main" }),
        agentId: undefined,
      }),
    ).resolves.toMatchObject({ status: "ok", scriptStateChanged: true });
    expect(resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects nextCheck without pacing before applying state", async () => {
    const { storePath } = await makeStorePath();
    const state = createCronServiceState({
      storePath,
      cronConfig: { triggers: { enabled: true } },
      runScriptJob: vi.fn(async () => ({
        status: "ok" as const,
        stateChanged: true,
        state: { revision: 2 },
        nextCheck: { delayMs: 5_000 },
      })),
    });

    await expect(executeJobCore(state, createDueScriptJob({ now }))).resolves.toEqual({
      status: "error",
      error: "cron script payload returned nextCheck, but this job has no pacing bounds",
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: {
        kind: "script-failure",
        source: "payload",
        code: "invalid_input",
      },
    });
  });

  it.each([
    { status: "ok", error: undefined, revision: 2, errors: 0 },
    { status: "error", error: "script threw", revision: 1, errors: 1 },
  ] as const)(
    "persists script state on $status runs only",
    async ({ status, error, revision, errors }) => {
      const job = await runStoredScript(createDueScriptJob({ now }), {
        status,
        error,
        stateChanged: true,
        state: { revision: 2 },
      });
      expect(job?.state.triggerState).toEqual({ revision });
      expect(job?.state.consecutiveErrors ?? 0).toBe(errors);
    },
  );

  it("records current-bound cron metadata against the backing cron session", async () => {
    const { storePath } = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "session-run-1",
      delivered: true,
      sessionKey: "agent:finn:cron:isolated-agent-job:run:run-1",
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    }));

    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        {
          ...createDueIsolatedAgentJob({ now }),
          sessionTarget: "current",
          sessionKey: "agent:finn:telegram:direct:42",
        },
      ],
    });

    const state = createCronServiceState({
      storePath,
      runIsolatedAgentJob,
    });

    await onTimer(state);

    const task = findCronRunByBaseRunId(storePath, `cron:isolated-agent-job:${now}`);
    if (!task) {
      throw new Error("expected isolated cron history record");
    }
    expect(task.sessionKey).toBe("agent:finn:cron:isolated-agent-job:run:run-1");
    expect(task.status).toBe("succeeded");
    expect(task.summary).toBe("done");
    expect(task.detail).toMatchObject({
      kind: "cron-run",
      status: "ok",
      sessionId: "session-run-1",
      durationMs: 0,
      nextRunAtMs: now + 60_000,
      delivery: { intended: { channel: "telegram", to: "42" } },
      model: "gpt-test",
      provider: "openai",
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });
  });
});

describe("cron quiet outcome finalization", () => {
  it.each([
    { mode: "retired-timer", failWrite: false },
    { mode: "timer", failWrite: true },
    { mode: "retired-manual", failWrite: true },
    { mode: "manual-force", failWrite: false },
  ])(
    "commits quiet trigger history with cron state ($mode, failWrite=$failWrite)",
    async ({ mode, failWrite }) => {
      const { storePath } = await makeStorePath();
      const job = {
        ...createDueIsolatedAgentJob({ now }),
        trigger: { script: "json({ fire: false })" },
      };
      const force = mode === "manual-force";
      const pendingSlot = now + 30 * 60_000;
      if (force) {
        job.pacing = { min: "15m", max: "4h" };
        job.state = {
          ...job.state,
          nextRunAtMs: pendingSlot,
          pacedNextRunAtMs: pendingSlot,
          startupCatchupAtMs: pendingSlot,
          forcePreservedNextRunAtMs: now + 15 * 60_000,
        };
      } else {
        job.state.pacedNextRunAtMs = job.state.nextRunAtMs;
      }
      await writeCronStoreSnapshot({ storePath, jobs: [job] });
      const database = openOpenClawStateDatabase().db;
      const state = createCronServiceState({
        storePath,
        cronConfig: { triggers: { enabled: true } },
        evaluateCronTrigger: vi.fn(async () => {
          if (mode.startsWith("retired")) {
            advanceCronActiveJobGeneration();
          }
          return { kind: "evaluated" as const, fire: false };
        }),
      });

      if (failWrite) {
        database.exec(`
        CREATE TRIGGER reject_quiet_terminal_row
        BEFORE UPDATE ON cron_jobs
        WHEN NEW.job_id = 'isolated-agent-job'
          AND json_extract(OLD.state_json, '$.runningAtMs') IS NOT NULL
          AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'quiet row unavailable');
        END;
      `);
      }
      try {
        const execution = mode.includes("manual")
          ? run(
              state,
              job.id,
              force ? "force" : "due",
              force ? { evaluateTrigger: true } : undefined,
            )
          : onTimer(state);
        if (failWrite) {
          await expect(execution).rejects.toThrow("quiet row unavailable");
          expect(findCronRunByBaseRunId(storePath, `cron:${job.id}:${now}`)).toBeUndefined();
          expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(now);
          return;
        }
        await execution;
        const persistedJob = (await loadCronStore(storePath)).jobs[0]!;
        expect(persistedJob.state.runningAtMs).toBeUndefined();
        expect(persistedJob.state.nextRunAtMs).toBeGreaterThan(now);
        if (force) {
          expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
            nextRunAtMs: pendingSlot,
            pacedNextRunAtMs: pendingSlot,
            startupCatchupAtMs: pendingSlot,
            forcePreservedNextRunAtMs: pendingSlot,
          });
        } else {
          expect((await loadCronStore(storePath)).jobs[0]?.state.pacedNextRunAtMs).toBeUndefined();
        }
        const task = findCronRunByBaseRunId(storePath, `cron:${job.id}:${now}`);
        expect(task).toMatchObject({ status: "succeeded" });
        expect(task?.detail).toEqual({
          storeKey: cronStoreKey(storePath),
          triggerFired: false,
          triggerStateChanged: false,
        });
      } finally {
        stop(state);
        database.exec("DROP TRIGGER IF EXISTS reject_quiet_terminal_row");
      }
    },
  );
});
