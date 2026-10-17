import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "../cron/heartbeat-monitor.js";
import { heartbeatTaskDeclarationKey, isHeartbeatTaskCronJob } from "../cron/heartbeat-task.js";
import { readCronJobScratchState } from "../cron/scratch-store.js";
import { writeCronJobScratchForMaintenance } from "../cron/scratch-write.kernel.js";
import { CronService } from "../cron/service.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { resolveHeartbeatSession } from "../infra/heartbeat-runner-session.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-schedule.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { useHeartbeatMigrationRoots } from "./doctor-heartbeat-migration.test-support.js";
import {
  collectHeartbeatTaskMigrationFindings,
  maybeMigrateHeartbeatTasksToCron,
} from "./doctor-heartbeat-task-migration.js";

const makeRoot = useHeartbeatMigrationRoots(
  "openclaw-heartbeat-task-migration-",
  closeOpenClawAgentDatabasesForTest,
);

function createTestCronService(storePath: string, cfg: OpenClawConfig, nowMs: number): CronService {
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop };
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    nowMs: () => nowMs,
    cronEnabled: false,
    cronConfig: cfg.cron,
    defaultAgentId: tryResolveAmbientOwnerAgentId(cfg),
    log,
    enqueueSystemEvent: () => false,
    requestHeartbeat: noop,
    runIsolatedAgentJob: async () => ({ status: "skipped", error: "not run" }),
  });
}

const task = (name: string, interval: string, prompt: string) =>
  `  - name: ${name}\n    interval: ${interval}\n    prompt: ${prompt}\n`;
const disabledTask = task("disabled", "5m", "This must remain disabled");

async function createFixture(
  nowMs = 2_000_000_000_000,
  scratchContent = "# Operations\n\ntasks:\n" +
    task("inbox", "1h", "Check urgent inbox items") +
    task("calendar", "2h", "Check the next meetings") +
    "\n# Keep alerts concise\n",
  agentId = "main",
) {
  const root = await makeRoot();
  const env = { ...process.env, HOME: path.join(root, "home"), OPENCLAW_STATE_DIR: root };
  process.env.HOME = env.HOME;
  process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
  const cfg = {
    agents: {
      ownership: "explicit",
      defaults: { heartbeat: { every: "30m" }, systemAgent: { agentId: "main" } },
      entries: { main: {}, [agentId]: {} },
    },
  } as OpenClawConfig;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const cron = createTestCronService(storePath, cfg, nowMs);
  const spec = resolveHeartbeatMonitorPlan(cfg, [], {
    schedulerSeed: resolveHeartbeatSchedulerSeed(undefined, { env }),
  }).specs.find((entry) => entry.input.agentId === agentId);
  if (!spec) {
    throw new Error("expected heartbeat monitor spec");
  }
  const added = await cron.add(spec.input, { enabledExplicit: true, systemOwned: true });
  const monitor = "job" in added ? added.job : added;
  writeCronJobScratchForMaintenance({
    storePath,
    jobId: monitor.id,
    content: scratchContent,
    expectedRevision: 0,
    options: { env },
  });
  const session = await resolveHeartbeatSession(
    cfg,
    agentId,
    cfg.agents?.defaults?.heartbeat,
    undefined,
    env,
  );
  await replaceSessionEntry(
    { storePath: session.storePath, sessionKey: session.sessionKey, env },
    {
      sessionId: `heartbeat-${agentId}`,
      updatedAt: nowMs,
      heartbeatTaskState: { inbox: nowMs - 30 * 60_000 },
    },
  );
  return {
    cfg,
    env,
    monitor,
    nowMs,
    session,
    storePath,
    migrate: (
      overrides: { env?: NodeJS.ProcessEnv; nowMs?: number; shouldRepair?: boolean } = {},
    ) => maybeMigrateHeartbeatTasksToCron({ cfg, env, shouldRepair: true, nowMs, ...overrides }),
    scratch: () => readCronJobScratchState(storePath, monitor.id, { env }),
    jobs: async () => (await loadCronJobsStore(storePath)).jobs.filter(isHeartbeatTaskCronJob),
    legacyState: async () =>
      (await resolveHeartbeatSession(cfg, "main", undefined, undefined, env)).entry
        ?.heartbeatTaskState,
  };
}

async function createExistingInboxJob(f: Awaited<ReturnType<typeof createFixture>>) {
  const cron = createTestCronService(f.storePath, f.cfg, f.nowMs - 60_000);
  const result = await cron.add(
    {
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      displayName: "Previous inbox task",
      name: "inbox",
      description: "Existing operator-owned state",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs: 5 * 60 * 60_000, anchorMs: f.nowMs - 60_000 },
      payload: { kind: "systemEvent", text: "Previous inbox prompt" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      state: { lastRunAtMs: f.nowMs - 10_000 },
    },
    { enabledExplicit: true, systemOwned: true, matchesExisting: isHeartbeatTaskCronJob },
  );
  return structuredClone("job" in result ? result.job : result);
}

it("keeps migrated secondary-agent tasks editable", async () => {
  const f = await createFixture(undefined, undefined, "research");
  await expect(f.migrate()).resolves.toMatchObject({ warnings: [] });
  const jobs = await f.jobs();
  expect(jobs).toHaveLength(2);
  const job = jobs.find((entry) => entry.name === "inbox")!;
  expect(job.agentId).toBe("research");
  const cron = createTestCronService(f.storePath, f.cfg, f.nowMs);
  const edited = {
    agentId: "research",
    payload: { kind: "systemEvent", text: "Check priority inbox items" },
  };
  try {
    await expect(
      cron.update(job.id, {
        payload: { kind: "systemEvent", text: "Check priority inbox items" },
      }),
    ).resolves.toMatchObject(edited);
    expect(
      (await loadCronJobsStore(f.storePath)).jobs.find((entry) => entry.id === job.id),
    ).toMatchObject({ declarationKey: job.declarationKey, ...edited });
    await expect(
      cron.add({
        name: "ordinary main-session job",
        agentId: "research",
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Check priority inbox items" },
      }),
    ).rejects.toThrow('sessionTarget "main" is only valid for the default agent');
  } finally {
    cron.stop();
  }
});

it("preserves persisted tasks for a disabled owner until it is re-enabled", async () => {
  const f = await createFixture();
  f.cfg.agents!.defaults!.heartbeat!.every = "0m";
  await expect(collectHeartbeatTaskMigrationFindings(f.cfg, f.env)).resolves.toEqual([]);
  await expect(f.migrate()).resolves.toEqual({ changes: [], warnings: [] });
  expect(await f.jobs()).toEqual([]);
  expect(f.scratch().scratch?.content).toContain("tasks:");
  f.cfg.agents!.defaults!.heartbeat!.every = "30m";
  await expect(f.migrate()).resolves.toMatchObject({
    warnings: [],
    changes: [expect.stringContaining("2 heartbeat tasks")],
  });
  expect(await f.jobs()).toHaveLength(2);
});

it("does not create shared state while detecting heartbeat tasks", async () => {
  const root = await makeRoot();
  const env = { ...process.env, HOME: path.join(root, "home"), OPENCLAW_STATE_DIR: root };
  const cfg = {
    agents: { defaults: { heartbeat: { every: "30m" } }, entries: { main: {} } },
  } as OpenClawConfig;
  await expect(collectHeartbeatTaskMigrationFindings(cfg, env)).resolves.toEqual([]);
  await expect(fs.stat(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("does not migrate older shared state while detecting heartbeat tasks", async () => {
  const f = await createFixture();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const statePath = resolveOpenClawStateSqlitePath(f.env);
  const older = openNodeSqliteDatabase(statePath);
  older.exec(`
      DROP INDEX idx_worker_session_placements_environment;
      PRAGMA user_version = 7;
      UPDATE schema_meta SET schema_version = 7 WHERE meta_key = 'primary';
    `);
  older.close();
  await expect(collectHeartbeatTaskMigrationFindings(f.cfg, f.env)).resolves.toHaveLength(1);
  const after = openNodeSqliteDatabase(statePath, { readOnly: true });
  expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  expect(
    after.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: 7 });
  after.close();
});

it("previews, preserves cadence, clears the block, and reruns idempotently", async () => {
  const f = await createFixture();
  await expect(collectHeartbeatTaskMigrationFindings(f.cfg, f.env)).resolves.toEqual([
    expect.objectContaining({
      checkId: "core/doctor/heartbeat-task-cron-migration",
      requirement: "heartbeat-tasks-in-scratch",
      target: "main",
    }),
  ]);
  const preview = await f.migrate({ shouldRepair: false });
  expect(preview).toEqual({ changes: [], warnings: [] });
  expect(await f.jobs()).toEqual([]);
  const migrated = await f.migrate();
  expect(migrated.warnings).toEqual([]);
  expect(migrated.changes).toHaveLength(1);
  const jobs = (await f.jobs()).toSorted((a, b) => a.name.localeCompare(b.name));
  expect(
    jobs.map((job) => ({ name: job.name, schedule: job.schedule, payload: job.payload })),
  ).toEqual([
    {
      name: "calendar",
      schedule: { kind: "every", everyMs: 2 * 60 * 60_000, anchorMs: f.nowMs + 1 },
      payload: { kind: "systemEvent", text: "Check the next meetings" },
    },
    {
      name: "inbox",
      schedule: { kind: "every", everyMs: 60 * 60_000, anchorMs: f.nowMs + 30 * 60_000 },
      payload: { kind: "systemEvent", text: "Check urgent inbox items" },
    },
  ]);
  expect(jobs.find((job) => job.name === "calendar")?.state.nextRunAtMs).toBe(f.nowMs + 1);
  expect(jobs.find((job) => job.name === "inbox")?.state.nextRunAtMs).toBe(f.nowMs + 30 * 60_000);
  const scratch = f.scratch().scratch;
  expect(scratch?.content).toContain("# Operations");
  expect(scratch?.content).toContain("# Keep alerts concise");
  expect(scratch?.content).not.toContain("tasks:");
  expect(await f.legacyState()).toBeUndefined();
  const rerun = await f.migrate({ nowMs: f.nowMs + 10_000 });
  expect(rerun).toEqual({ changes: [], warnings: [] });
  expect(await f.jobs()).toHaveLength(2);
});

it("leaves cron jobs and legacy timestamps untouched when the scratch revision changes", async () => {
  const f = await createFixture();
  const existingSnapshot = await createExistingInboxJob(f);
  const concurrentScratch =
    "# Concurrent replacement\ntasks:\n" +
    task("follow-up", "3h", "Run the concurrent follow-up") +
    "# Keep concurrent prose\n";
  const migration = f.migrate();
  const current = f.scratch();
  writeCronJobScratchForMaintenance({
    storePath: f.storePath,
    jobId: f.monitor.id,
    content: concurrentScratch,
    expectedRevision: current.currentRevision,
    options: { env: f.env },
  });
  const result = await migration;
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain("scratch changed during task migration");
  expect(f.scratch().scratch?.content).toBe(concurrentScratch);
  const jobs = await f.jobs();
  expect(jobs).toEqual([existingSnapshot]);
  expect(await f.legacyState()).toEqual({ inbox: f.nowMs - 30 * 60_000 });
});

it("serializes two plans pinned to one scratch revision and converges the loser on rerun", async () => {
  const f = await createFixture();
  const outcomes = await Promise.all([f.migrate(), f.migrate()]);
  expect(outcomes.filter((outcome) => outcome.changes.length === 1)).toHaveLength(1);
  expect(
    outcomes.filter((outcome) =>
      outcome.warnings.some((warning) => warning.includes("scratch changed during task migration")),
    ),
  ).toHaveLength(1);
  const committedJobs = await f.jobs();
  expect(committedJobs).toHaveLength(2);
  expect(new Set(committedJobs.map((job) => job.declarationKey)).size).toBe(2);
  expect(f.scratch().scratch?.content).not.toContain("tasks:");
  const rerun = await f.migrate({ nowMs: f.nowMs + 10_000 });
  expect(rerun).toEqual({ changes: [], warnings: [] });
  expect(await f.jobs()).toEqual(committedJobs);
});

it("tolerates a crash after the state transaction and before legacy timestamp cleanup", async () => {
  const f = await createFixture();
  const cleanup = vi
    .spyOn(sessionAccessor, "patchSessionEntryCore")
    .mockRejectedValueOnce(new Error("simulated post-commit crash"));
  const result = await f.migrate();
  expect(result.changes).toHaveLength(1);
  expect(result.warnings.join("\n")).toContain("simulated post-commit crash");
  const committedJobs = await f.jobs();
  expect(committedJobs).toHaveLength(2);
  expect(f.scratch().scratch?.content).not.toContain("tasks:");
  expect(await f.legacyState()).toEqual({ inbox: f.nowMs - 30 * 60_000 });
  cleanup.mockRestore();
  await expect(f.migrate({ nowMs: f.nowMs + 10_000 })).resolves.toEqual({
    changes: [],
    warnings: [],
  });
  expect(await f.jobs()).toEqual(committedJobs);
});

it("refuses orphan task fields beside a valid task without changing scratch", async () => {
  const content =
    "# Operations\ntasks:\n  interval: 15m\n  prompt: Orphaned work must not disappear\n" +
    task("inbox", "1h", "Check urgent inbox items") +
    "# Keep alerts concise\n";
  const f = await createFixture(undefined, content);
  await expect(collectHeartbeatTaskMigrationFindings(f.cfg, f.env)).resolves.toEqual([
    expect.objectContaining({
      severity: "error",
      requirement: "heartbeat-task-migration-blocked",
      message: expect.stringContaining("incomplete name/interval/prompt entry"),
    }),
  ]);
  const result = await f.migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings.join("\n")).toContain("incomplete name/interval/prompt entry");
  expect(f.scratch().scratch?.content).toBe(content);
  expect(await f.jobs()).toEqual([]);
});

it("does not migrate a task block hidden by a mid-line HTML comment opener", async () => {
  const content = `Notes <!--\ntasks:\n${disabledTask}-->\n# Keep this scratch\n`;
  const f = await createFixture(undefined, content);
  await expect(collectHeartbeatTaskMigrationFindings(f.cfg, f.env)).resolves.toEqual([]);
  await expect(f.migrate()).resolves.toEqual({ changes: [], warnings: [] });
  expect(await f.jobs()).toEqual([]);
  expect(f.scratch().scratch?.content).toBe(content);
});

it("keeps a multiline comment closed when its opener shares a migrated task line", async () => {
  const content =
    "tasks:\n" +
    task("active", "1h", "Run the active check <!--") +
    `tasks:\n${disabledTask}-->\n# Keep this scratch\n`;
  const f = await createFixture(undefined, content);
  const migrated = await f.migrate();
  expect(migrated.warnings).toEqual([]);
  const jobs = await f.jobs();
  expect(jobs.map((job) => job.name)).toEqual(["active"]);
  const scratch = f.scratch().scratch?.content;
  expect(scratch).toContain(`<!--\ntasks:\n${disabledTask}-->`);
  await expect(f.migrate({ nowMs: f.nowMs + 10_000 })).resolves.toEqual({
    changes: [],
    warnings: [],
  });
});
