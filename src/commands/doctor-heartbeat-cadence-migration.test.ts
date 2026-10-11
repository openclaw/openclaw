import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as clawHeartbeatMigration from "../claws/heartbeat-migration.js";
import { findLegacyConfigIssues } from "../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type { LegacyHeartbeatConfig } from "../config/types.agent-defaults.js";
import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.js";
import { readScratchStateFromDatabase } from "../cron/scratch-read.kernel.js";
import { writeCronJobScratchInDatabase } from "../cron/scratch-write.kernel.js";
import { CronService } from "../cron/service.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import {
  readCronRunRecordsInDatabase,
  recordCronRunInDatabase,
} from "../cron/store/run-history.kernel.js";
import {
  loadCronRuntimeAuthorities,
  replaceCronRuntimeAuthorityRows,
} from "../cron/store/runtime-authority-store.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import type { CronStoredJob } from "../cron/types.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { prepareAutomaticHeartbeatRepair } from "./doctor-automatic-heartbeat-repair.js";
import {
  collectHeartbeatCadenceMigrationFindings,
  ensureHeartbeatMonitorJobs,
  maybeMigrateHeartbeatCadenceToCron,
} from "./doctor-heartbeat-cadence-migration.js";
import type { DoctorCronJob } from "./doctor-heartbeat-jobs.js";
import { retireHeartbeatWithDoctor } from "./doctor-heartbeat-retirement.js";
import { resolveHeartbeatPhaseMs } from "./doctor-heartbeat-schedule.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

function fixture(heartbeat: LegacyHeartbeatConfig = { every: "15m" }) {
  const root = tempDirs.make("openclaw-heartbeat-cadence-");
  const env = { ...process.env, HOME: path.join(root, "home"), OPENCLAW_STATE_DIR: root };
  vi.stubEnv("HOME", env.HOME);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const cfg: OpenClawConfigWithLegacyRoster = {
    agents: {
      defaults: { heartbeat },
      list: [{ id: "main", workspace: path.join(root, "workspace") }],
    },
  };
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  return { root, env, cfg, storePath, storeKey: cronStoreKey(storePath) };
}
type Fixture = ReturnType<typeof fixture>;

function readState(f: Fixture) {
  return withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const rows = loadCronRows(db, f.storeKey);
      const jobs = loadedCronStoreFromRows(rows).store.jobs;
      loadCronRuntimeAuthorities({ db, storeKey: f.storeKey, jobs });
      return {
        rows,
        jobs,
        receipt: readDefaultProactiveJobReceiptInDatabase(db, f.storePath, "main"),
        history: readCronRunRecordsInDatabase(db),
        scratch: new Map(
          jobs.map((job) => [job.id, readScratchStateFromDatabase(db, f.storeKey, job.id)]),
        ),
      };
    },
    { env: f.env },
  );
}

function writeJob(f: Fixture, job: CronStoredJob) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      upsertCronJobRow(db, f.storeKey, job, 0);
      replaceCronRuntimeAuthorityRows({ db, storeKey: f.storeKey, jobs: [job] });
    },
    { env: f.env },
  );
}

function deleteJob(f: Fixture, jobId: string) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .deleteFrom("cron_jobs")
          .where("store_key", "=", f.storeKey)
          .where("job_id", "=", jobId),
      );
    },
    { env: f.env },
  );
}

function seedLegacyMonitor(f: Fixture, overrides: Partial<Omit<DoctorCronJob, "payload">> = {}) {
  const legacy: DoctorCronJob = {
    id: "july-monitor",
    agentId: "main",
    declarationKey: "heartbeat:main",
    name: "Existing checklist",
    enabled: true,
    createdAtMs: Date.parse("2026-07-15T12:00:00Z"),
    updatedAtMs: NOW - 60_000,
    schedule: { kind: "every", everyMs: 900_000, anchorMs: 37 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    state: {
      nextRunAtMs: NOW + 123,
      queuedAtMs: NOW + 123,
      lastRunAtMs: NOW - 900_000,
      lastRunStatus: "ok",
    },
    ...overrides,
    payload: { kind: "heartbeat", toolsAllow: ["read"], toolsAllowIsDefault: false },
  };
  // The retired discriminator cannot enter through the ordinary job writer.
  // A system-event placeholder also reproduces the shipped authority fingerprint.
  const placeholder: CronStoredJob = {
    ...legacy,
    payload: {
      kind: "systemEvent",
      text: "Legacy monitor",
      toolsAllow: ["read"],
      toolsAllowIsDefault: false,
    },
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      upsertCronJobRow(db, f.storeKey, placeholder, 0);
      replaceCronRuntimeAuthorityRows({ db, storeKey: f.storeKey, jobs: [placeholder] });
      const row = loadCronRows(db, f.storeKey).find((candidate) => candidate.job_id === legacy.id)!;
      executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .updateTable("cron_jobs")
          .set({
            payload_kind: "heartbeat",
            job_json: JSON.stringify({ ...JSON.parse(row.job_json), payload: legacy.payload }),
          })
          .where("store_key", "=", f.storeKey)
          .where("job_id", "=", legacy.id),
      );
      writeCronJobScratchInDatabase(db, {
        storeKey: f.storeKey,
        jobId: legacy.id,
        content: "Check the backup.\n",
        expectedRevision: 0,
        nowMs: NOW - 1000,
      });
      recordCronRunInDatabase(db, {
        storeKey: f.storeKey,
        jobId: legacy.id,
        runId: `cron:${legacy.id}:previous`,
        agentId: "main",
        startedAt: NOW - 900_000,
        endedAt: NOW - 899_000,
        status: "succeeded",
        summary: "No change",
        detail: { storeKey: f.storeKey },
      });
    },
    { env: f.env },
  );
  return legacy;
}

describe("heartbeat cadence Doctor cutover", () => {
  it("previews without creating state, identity, or changing the input config", async () => {
    const f = fixture();
    const input = structuredClone(f.cfg);
    expect(await collectHeartbeatCadenceMigrationFindings(f.cfg, f.env)).toEqual([
      expect.objectContaining({ requirement: "heartbeat-retirement" }),
    ]);
    expect(
      await maybeMigrateHeartbeatCadenceToCron({ cfg: f.cfg, env: f.env, shouldRepair: false }),
    ).toMatchObject({ changes: [] });
    expect(f.cfg).toEqual(input);
    await expect(fs.access(resolveOpenClawStateSqlitePath(f.env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readdir(f.root)).toEqual([]);
  });

  it.each(["removed-owner-receipt", "invalid-legacy-row"])(
    "preserves automatic admission semantics for %s",
    async (storedState) => {
      const f = fixture();
      const job = (await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env)).get("main")!;
      if (storedState === "invalid-legacy-row") {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE cron_jobs SET payload_kind = 'heartbeat', job_json = '{' WHERE job_id = ?",
            ).run(job.id);
          },
          { env: f.env },
        );
      }
      const config: OpenClawConfigWithLegacyRoster = {
        agents: {
          ownership: "explicit",
          entries: { other: { workspace: path.join(f.root, "other") } },
        },
        gateway: { mode: "local" },
        plugins: { enabled: false },
      };
      const configPath = path.join(f.root, "openclaw.json");
      const original = JSON.stringify(config);
      await fs.writeFile(configPath, original);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const env = {
        ...f.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      };
      const readRows = () =>
        withExistingOpenClawStateDatabaseReadOnly(({ db }) => loadCronRows(db, f.storeKey), {
          env,
        });
      const before = readRows();
      const admission = prepareAutomaticHeartbeatRepair({ nonInteractive: true }, env);
      if (storedState === "invalid-legacy-row") {
        await expect(admission).rejects.toThrow("invalid stored JSON");
        expect(await collectHeartbeatCadenceMigrationFindings(config, env)).toEqual([
          expect.objectContaining({
            severity: "error",
            requirement: "heartbeat-retirement-inspection",
          }),
        ]);
      } else {
        expect(await admission).toBeDefined();
        expect(await collectHeartbeatCadenceMigrationFindings(config, env)).toEqual([
          expect.objectContaining({ severity: "warning", requirement: "heartbeat-retirement" }),
        ]);
        const receipt = readState(f)!.receipt;
        await expect(retireHeartbeatWithDoctor(config, env)).rejects.toThrow(
          `Agent main has an incomplete automation cutover for job ${job.id} but is no longer configured`,
        );
        expect(readState(f)!.receipt).toEqual(receipt);
      }
      expect(readRows()).toEqual(before);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    },
  );

  it.each([true, false])(
    "preserves July-era identity, anchors, history, scratch, pending work, and authority (enabled: %s)",
    async (enabled) => {
      const f = fixture();
      const authority = {
        version: 1 as const,
        runtimeId: "fixture-runtime",
        namespace: "fixture-authority",
        payload: { binding: "preserved" },
      };
      const legacy = seedLegacyMonitor(f, { enabled, runtimeAuthority: authority });
      const previous = readState(f)!;
      const scratch = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => readScratchStateFromDatabase(db, f.storeKey, legacy.id),
        { env: f.env },
      );

      const pending = await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
      const converted = readState(f)!;
      expect(pending.get("main")?.id).toBe(legacy.id);
      expect(converted.receipt).toMatchObject({ jobId: legacy.id, phase: "pending" });
      expect(converted.jobs).toEqual([
        expect.objectContaining({
          id: legacy.id,
          name: legacy.name,
          createdAtMs: legacy.createdAtMs,
          enabled,
          schedule: legacy.schedule,
          state: legacy.state,
          runtimeAuthority: authority,
          payload: expect.objectContaining({
            kind: "agentTurn",
            toolsAllow: ["read"],
            toolsAllowIsDefault: false,
          }),
        }),
      ]);
      expect(converted.jobs[0]?.declarationKey).toBeUndefined();
      expect(converted.jobs[0]?.runtimeAuthorityRecoveryRequired).toBeUndefined();
      expect(converted.scratch.get(legacy.id)).toEqual(scratch);
      expect(converted.history).toEqual(previous.history);

      const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
      expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
      expect(f.cfg.agents?.defaults?.heartbeat).toEqual({ every: "15m" });
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      const reopened = readState(f)!;
      expect(reopened.receipt).toMatchObject({ jobId: legacy.id, phase: "complete" });
      expect(reopened.jobs).toEqual(converted.jobs);
      expect(reopened.history).toEqual(previous.history);
      expect(reopened.scratch.get(legacy.id)).toEqual(scratch);
    },
  );

  it("preserves a provider-resolved hourly cadence when the legacy config has no authored interval", async () => {
    const f = fixture({ prompt: "Check the backup report." });
    const legacy = seedLegacyMonitor(f, {
      schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 37 },
    });

    const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
    expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
    expect(readState(f)!.jobs).toEqual([
      expect.objectContaining({
        id: legacy.id,
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: 37 },
        state: legacy.state,
        payload: expect.objectContaining({
          kind: "agentTurn",
          message: "Check the backup report.",
        }),
      }),
    ]);
  });

  it("migrates standalone acknowledgments in a July custom prompt without changing other bytes", async () => {
    const prompt =
      " \n\tKeep MY_HEARTBEAT_OK and HEARTBEAT_OKAY unchanged. If quiet, reply HEARTBEAT_OK.\n" +
      "Keep αHEARTBEAT_OK and HEARTBEAT_OK2 unchanged.  \n";
    const f = fixture({ every: "15m", prompt });
    const legacy = seedLegacyMonitor(f);

    const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
    const converted = readState(f)!.jobs;
    expect(converted).toEqual([
      expect.objectContaining({
        id: legacy.id,
        payload: expect.objectContaining({
          kind: "agentTurn",
          message:
            " \n\tKeep MY_HEARTBEAT_OK and HEARTBEAT_OKAY unchanged. If quiet, reply NO_REPLY.\n" +
            "Keep αHEARTBEAT_OK and HEARTBEAT_OK2 unchanged.  \n",
        }),
      }),
    ]);
    expect(f.cfg.agents?.defaults?.heartbeat?.prompt).toBe(prompt);
    await retireHeartbeatWithDoctor(retired, f.env);
    expect(readState(f)!.jobs).toEqual(converted);
  });

  it.each([
    { every: "37m", perAgent: false, enabled: true },
    { every: "37m", perAgent: true, enabled: true },
    { every: "0m", perAgent: true, enabled: false },
  ])(
    "transfers effective cadence $every before removing config (agent override: $perAgent)",
    async ({ every, perAgent, enabled }) => {
      const f = fixture({ every: perAgent ? "11m" : every });
      if (perAgent) {
        f.cfg.agents!.entries = {
          main: { workspace: path.join(f.root, "workspace"), heartbeat: { every } },
        };
        delete f.cfg.agents!.list;
      }
      const legacy = seedLegacyMonitor(f);
      const next = await retireHeartbeatWithDoctor(f.cfg, f.env);
      const job = readState(f)!.jobs[0]!;
      expect(next.agents?.defaults?.heartbeat).toBeUndefined();
      expect(next.agents?.entries?.main?.heartbeat).toBeUndefined();
      expect(job).toMatchObject({
        id: legacy.id,
        enabled,
        state: { lastRunAtMs: legacy.state.lastRunAtMs, lastRunStatus: "ok" },
      });
      if (enabled) {
        expect(job.state.queuedAtMs).toBe(legacy.state.queuedAtMs);
        expect(job.state.scheduleActivatedAtMs).toBe(NOW);
        expect(job.schedule).toMatchObject({ kind: "every", everyMs: 2_220_000 });
        expect(job.state.nextRunAtMs).toBeGreaterThan(NOW);
      } else {
        expect(job.schedule).toEqual(legacy.schedule);
        expect(job.state.nextRunAtMs).toBeUndefined();
        expect(job.state.queuedAtMs).toBeUndefined();
      }
    },
  );

  it.each([
    {
      target: "owner",
      isolatedSession: false,
      delivery: { mode: "announce", target: "owner", directPolicy: "block" },
    },
    {
      target: "last",
      isolatedSession: false,
      delivery: { mode: "announce", channel: "last", to: "synthetic-room", directPolicy: "block" },
    },
    { target: "none", isolatedSession: false, delivery: { mode: "none", directPolicy: "block" } },
    {
      target: "telegram",
      isolatedSession: true,
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "12345678:topic:42",
        accountId: "ops",
        directPolicy: "block",
      },
    },
  ])(
    "preserves quiet hours, execution policy, and $target delivery",
    async ({ target, isolatedSession, delivery }) => {
      const f = fixture({
        every: "15m",
        target,
        isolatedSession,
        to: target === "telegram" ? "12345678:topic:42" : "synthetic-room",
        ...(target === "telegram" ? { accountId: "ops" } : {}),
        directPolicy: "block",
        session: "agent:main:custom",
        model: "openai/gpt-5",
        lightContext: true,
        timeoutSeconds: 75,
        prompt: "Check the backup report.",
        activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" },
      });
      await retireHeartbeatWithDoctor(f.cfg, f.env);
      expect(readState(f)!.jobs[0]).toMatchObject({
        sessionTarget: isolatedSession ? "isolated" : "session:agent:main:custom",
        sessionKey: "agent:main:custom",
        idleOnly: true,
        activeHours: { start: "22:00", end: "06:00", timezone: "America/New_York" },
        payload: {
          kind: "agentTurn",
          message: "Check the backup report.",
          model: "openai/gpt-5",
          lightContext: true,
          timeoutSeconds: 75,
          skipIfScratchEmpty: true,
        },
        delivery,
      });
    },
  );

  it.each([true, false])(
    "preserves prepared account-key ownership in alert migration (identity=%s)",
    async (hasIdentity) => {
      const f = fixture({
        every: "15m",
        target: "phone",
        to: "synthetic-recipient",
        accountId: "work-phone",
      });
      f.cfg.channels = {
        phone: {
          heartbeatVisibility: { showAlerts: true },
          accounts: {
            "Work Phone": {
              ...(hasIdentity ? { account: "+12025550103" } : {}),
              heartbeatVisibility: { showAlerts: false },
            },
          },
        },
      };
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "phone-owner",
            channels: ["phone"],
            channelAccountKeyPolicies: { phone: { canonicalAliasesRequireOwnField: "account" } },
          },
        ],
      });
      const original = structuredClone(f.cfg);
      await withPluginMetadataSnapshotScope(snapshot, () =>
        retireHeartbeatWithDoctor(f.cfg, f.env),
      );
      expect(readState(f)!.jobs).toEqual([
        expect.objectContaining({
          delivery: {
            mode: hasIdentity ? "none" : "announce",
            channel: "phone",
            to: "synthetic-recipient",
            accountId: "work-phone",
          },
        }),
      ]);
      expect(f.cfg).toEqual(original);
    },
  );

  it.each(["telegram", "owner", "last"])(
    "retains mixed account visibility for the dynamic %s route",
    async (target) => {
      const f = fixture({ every: "15m", target, to: "synthetic-recipient" });
      f.cfg.channels = {
        telegram: {
          defaultAccount: "ops",
          accounts: {
            alternate: { heartbeatVisibility: { showAlerts: false } },
            ops: { heartbeatVisibility: { showAlerts: true } },
          },
        },
      };
      const original = structuredClone(f.cfg);
      const before = readState(f);
      await expect(retireHeartbeatWithDoctor(f.cfg, f.env)).rejects.toThrow(
        "Mixed channel/account heartbeat alert visibility",
      );
      expect(readState(f)).toEqual(before);
      expect(f.cfg).toEqual(original);
    },
  );

  it.each([false, true])(
    "preserves Feishu-owned visibility while migrating shared controls=%s",
    async (sharedControls) => {
      const f = fixture({ every: "15m", target: "feishu", to: "synthetic-chat", accountId: "ops" });
      const feishu = {
        heartbeatVisibility: { visibility: "hidden", intervalMs: 30_000 },
        accounts: { ops: { heartbeatVisibility: { visibility: "visible", intervalMs: 10_000 } } },
      };
      f.cfg.channels = {
        defaults: { heartbeatVisibility: { showAlerts: true } },
        feishu: {
          ...feishu,
          ...(sharedControls ? { heartbeat: { showAlerts: true } } : {}),
          accounts: {
            ops: {
              ...feishu.accounts.ops,
              ...(sharedControls ? { heartbeat: { showAlerts: false } } : {}),
            },
          },
        },
      };
      const original = structuredClone(f.cfg);
      const monitor = seedLegacyMonitor(f);
      const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
      expect(retired.channels?.feishu).toEqual(feishu);
      expect(retired.channels?.defaults?.heartbeatVisibility).toBeUndefined();
      expect(findLegacyConfigIssues({ channels: retired.channels })).toEqual([]);
      expect(f.cfg).toEqual(original);
      const migrated = readState(f)!.jobs;
      expect(migrated).toEqual([
        expect.objectContaining({
          id: monitor.id,
          delivery: {
            mode: sharedControls ? "none" : "announce",
            channel: "feishu",
            to: "synthetic-chat",
            accountId: "ops",
          },
        }),
      ]);
      await retireHeartbeatWithDoctor(retired, f.env);
      expect(readState(f)!.jobs).toEqual(migrated);
    },
  );

  it.each([
    { activeHours: { start: "22:00" }, expected: undefined },
    { activeHours: { end: "06:00" }, expected: undefined },
    {
      activeHours: { start: "22:00", end: "06:00", timezone: "Not/A_Zone" },
      expected: { start: "22:00", end: "06:00", timezone: "user" },
    },
    {
      activeHours: { start: "22:00", end: "06:00", timezone: "   " },
      expected: { start: "22:00", end: "06:00", timezone: "user" },
    },
  ])("preserves legacy active-hours fallback: $activeHours", async ({ activeHours, expected }) => {
    const f = fixture({ every: "15m", activeHours });
    await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
    expect(readState(f)!.jobs[0]?.activeHours).toEqual(expected);
  });

  it("leaves completed automations editable and never recreates a deleted job", async () => {
    const f = fixture();
    const note = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
    await retireHeartbeatWithDoctor(f.cfg, f.env);
    const deliveryNotes = () =>
      note.mock.calls.filter(([, title]) => title === "Heartbeat delivery changed");
    expect(deliveryNotes()).toEqual([
      [
        expect.stringMatching(
          /standard Automations delivery.*duplicate suppression and no-route skipping were removed/,
        ),
        "Heartbeat delivery changed",
      ],
    ]);
    const original = readState(f)!.jobs[0]!;
    const edited: CronStoredJob = {
      ...original,
      enabled: false,
      name: "Operator checklist",
      schedule: { kind: "every", everyMs: 2_700_000, anchorMs: 123 },
      payload: { kind: "agentTurn", message: "Operator instructions", toolsAllow: ["read"] },
      delivery: { mode: "none" },
    };
    writeJob(f, edited);
    const saved = readState(f)!.jobs;
    f.cfg.agents!.defaults!.heartbeat!.every = "1m";
    await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
    expect(readState(f)!.jobs).toEqual(saved);
    deleteJob(f, original.id);
    const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
    expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
    expect(readState(f)!.jobs).toEqual([]);
    expect(readState(f)!.receipt).toMatchObject({ jobId: original.id, phase: "complete" });
    expect(deliveryNotes()).toHaveLength(1);
  });

  it("keeps cutover pending when installed provenance fails and resumes without duplicating jobs", async () => {
    const f = fixture();
    const legacy = seedLegacyMonitor(f);
    const input = structuredClone(f.cfg);
    const finish = vi
      .spyOn(clawHeartbeatMigration, "finishClawHeartbeatMigration")
      .mockRejectedValueOnce(new Error("Synthetic installed-provenance failure"));

    await expect(retireHeartbeatWithDoctor(f.cfg, f.env)).rejects.toThrow(
      "Synthetic installed-provenance failure",
    );
    const pending = readState(f)!;
    expect(pending.jobs).toEqual([
      expect.objectContaining({
        id: legacy.id,
        payload: expect.objectContaining({ kind: "agentTurn" }),
      }),
    ]);
    expect(pending.scratch.get(legacy.id)?.scratch?.content).toBe("Check the backup.\n");
    expect(pending.receipt).toMatchObject({ jobId: legacy.id, phase: "pending" });
    expect(f.cfg).toEqual(input);

    finish.mockRestore();
    const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
    expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
    const completed = readState(f)!;
    expect(completed.jobs).toEqual(pending.jobs);
    expect(completed.scratch).toEqual(pending.scratch);
    expect(completed.receipt).toMatchObject({ jobId: legacy.id, phase: "complete" });
  });

  it.each(["explicit", "session", "default"] as const)(
    "does not execute a pending migration through its %s owner after a public job edit",
    async (owner) => {
      const f = fixture();
      seedLegacyMonitor(f);
      const job = (await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env)).get("main")!;
      const pending = readState(f)!;
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          writeCronJobScratchInDatabase(db, {
            storeKey: f.storeKey,
            jobId: job.id,
            content:
              "tasks:\n  - name: recovery\n    interval: 1h\n    prompt: Check the backup.\n\nKeep this checklist.\n",
            expectedRevision: pending.scratch.get(job.id)!.currentRevision,
            nowMs: NOW,
          });
        },
        { env: f.env },
      );
      const pendingReceipt = readState(f)!.receipt;
      expect(pendingReceipt).toMatchObject({ jobId: job.id, phase: "pending" });
      const scheduler = createTestGatewayScheduler();
      const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        scheduler,
        storePath: f.storePath,
        cronEnabled: true,
        defaultAgentId: "unrelated",
        resolveDefaultAgentId: () => "main",
        log: { debug() {}, info() {}, warn() {}, error() {} },
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        runIsolatedAgentJob,
      });
      try {
        const updated = await cron.update(job.id, {
          name: "Edited checklist",
          ...(owner === "explicit" ? {} : { agentId: "" }),
          ...(owner === "default" ? { sessionKey: "" } : {}),
        });
        expect(updated.agentId).toBe(owner === "explicit" ? "main" : undefined);
        expect(updated.sessionKey).toBe(owner === "default" ? undefined : job.sessionKey);
        expect(readState(f)!.receipt).toEqual(pendingReceipt);

        await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
        const afterRun = readState(f)!;
        expect(afterRun.jobs[0]!.state).toMatchObject({
          lastRunStatus: "error",
          lastError: "Automation migration is incomplete; run openclaw doctor --fix",
        });
        expect(runSessionEvent).not.toHaveBeenCalled();
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
        expect(afterRun.receipt).toEqual(pendingReceipt);
        if (owner === "default") {
          const differentOwnerConfig = {
            ...f.cfg,
            agents: {
              ...f.cfg.agents,
              defaults: {
                ...f.cfg.agents?.defaults,
                heartbeat: { ...f.cfg.agents?.defaults?.heartbeat, agentId: "main" },
                systemAgent: { agentId: "other" },
              },
              list: [...(f.cfg.agents?.list ?? []), { id: "other" }],
            },
          };
          await expect(retireHeartbeatWithDoctor(differentOwnerConfig, f.env)).rejects.toThrow(
            "changed owner or payload during an incomplete cutover",
          );
          expect(readState(f)).toEqual(afterRun);
        }

        const retired = await retireHeartbeatWithDoctor(f.cfg, f.env);
        const completed = readState(f)!;
        expect(retired.agents?.defaults?.heartbeat).toBeUndefined();
        expect(completed.jobs.find((entry) => entry.id === job.id)).toEqual(afterRun.jobs[0]);
        const task = completed.jobs.find((entry) => entry.name === "recovery");
        expect(task).toMatchObject({
          agentId: "main",
          payload: { kind: "agentTurn", message: "Check the backup." },
        });
        expect(completed.jobs).toHaveLength(2);
        expect(completed.receipt).toMatchObject({
          jobId: job.id,
          phase: "complete",
          convertedJobIds: [task!.id],
        });
        expect(completed.history).toEqual(afterRun.history);
        expect(completed.scratch.get(job.id)?.scratch?.content).toContain("Keep this checklist.");
        expect(completed.scratch.get(job.id)?.scratch?.content).not.toContain("tasks:");
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await scheduler.stop();
      }
    },
  );

  it("refuses a deleted pending job while retaining legacy config and its receipt", async () => {
    const f = fixture();
    const input = structuredClone(f.cfg);
    const job = (await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env)).get("main")!;
    deleteJob(f, job.id);
    await expect(retireHeartbeatWithDoctor(f.cfg, f.env)).rejects.toThrow("incomplete cutover");
    expect(f.cfg).toEqual(input);
    expect(readState(f)!.jobs).toEqual([]);
    expect(readState(f)!.receipt).toMatchObject({ jobId: job.id, phase: "pending" });
  });

  it.each([
    { every: "not-a-duration" },
    { every: "15m", activeHours: { start: "25:00", end: "06:00" } },
  ])("retains malformed legacy input and persisted rows: %j", async (heartbeat) => {
    const f = fixture(heartbeat);
    seedLegacyMonitor(f);
    const rows = readState(f)!.rows;
    const input = structuredClone(f.cfg);
    await expect(retireHeartbeatWithDoctor(f.cfg, f.env)).rejects.toThrow();
    expect(f.cfg).toEqual(input);
    expect(readState(f)!.rows).toEqual(rows);
    expect(readState(f)!.receipt).toBeUndefined();
  });

  it("transfers an unexecuted one-shot retry without changing its previous outcome", async () => {
    const f = fixture();
    const previous: CronStoredJob = {
      id: "pending-reminder",
      agentId: "main",
      name: "Reminder",
      enabled: true,
      createdAtMs: NOW - 1000,
      updatedAtMs: NOW - 500,
      schedule: { kind: "at", at: "2026-07-15T12:00:00Z" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Reminder" },
      state: {
        lastRunAtMs: NOW - 100,
        nextRunAtMs: NOW + 100,
        lastRunStatus: "skipped",
        lastError: "disabled",
        consecutiveSkipped: 1,
      },
    };
    writeJob(f, previous);
    const persisted = readState(f)!.jobs.find((job) => job.id === previous.id)!;
    await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
    const converted = readState(f)!.jobs.find((job) => job.id === previous.id)!;
    expect(converted).toEqual({
      ...persisted,
      state: { ...persisted.state, startupCatchupAtMs: NOW + 100 },
    });
    await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
    expect(readState(f)!.jobs.find((job) => job.id === previous.id)).toEqual(converted);
  });

  it("uses the supplied environment for scheduler identity and storage", async () => {
    const f = fixture();
    const ambientRoot = tempDirs.make("openclaw-heartbeat-ambient-");
    const ambientEnv = {
      ...f.env,
      HOME: path.join(ambientRoot, "home"),
      OPENCLAW_STATE_DIR: ambientRoot,
    };
    vi.stubEnv("HOME", ambientEnv.HOME);
    vi.stubEnv("OPENCLAW_STATE_DIR", ambientRoot);
    const ambient = loadOrCreateDeviceIdentity({ env: ambientEnv });
    const supplied = loadOrCreateDeviceIdentity({ env: f.env });
    const phase = (deviceId: string, agentId: string) =>
      resolveHeartbeatPhaseMs({ schedulerSeed: deviceId, agentId, intervalMs: 900_000 });
    const agentId = ["main", "ops", "alpha", "beta"].find(
      (candidate) => phase(ambient.deviceId, candidate) !== phase(supplied.deviceId, candidate),
    );
    if (!agentId) {
      throw new Error("Expected distinct scheduler phases for the independent identities");
    }
    f.cfg.agents!.list![0]!.id = agentId;
    await ensureHeartbeatMonitorJobs(f.cfg, f.storePath, f.env);
    expect(readState(f)!.jobs[0]?.schedule).toEqual({
      kind: "every",
      everyMs: 900_000,
      anchorMs: phase(supplied.deviceId, agentId),
    });
    expect(
      withExistingOpenClawStateDatabaseReadOnly(({ db }) => loadCronRows(db, f.storeKey), {
        env: ambientEnv,
      }),
    ).toEqual([]);
  });
});
