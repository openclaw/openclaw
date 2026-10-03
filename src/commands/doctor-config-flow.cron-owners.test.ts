import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, transformConfigFile } from "../config/config.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../cron/agent-id.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { CronService } from "../cron/service.js";
import { saveCronJobsStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { mintCronStandingGrantLocked } from "../gateway/operator-approval-standing-grants.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { pruneAgentConfig } from "./agents.config.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";
import { maybeRepairLegacyCronStore } from "./doctor/cron/index.js";

afterEach(() => vi.restoreAllMocks());

function sourceConfig(storePath?: string) {
  return {
    agents: {
      defaults: { systemAgent: { agentId: "research" } },
      entries: { ops: { default: true }, research: {} },
    },
    gateway: { mode: "local" as const },
    plugins: { enabled: false },
    ...(storePath ? { cron: { store: storePath } } : {}),
  };
}

async function seedJobs(storePath: string) {
  await saveCronJobsStore(storePath, {
    version: 1,
    jobs: [
      makeCronJob({
        id: "historical",
        enabled: false,
        state: { lastRunAtMs: 123, lastRunStatus: "ok" },
      }),
      makeCronJob({ id: "explicit", agentId: "research", enabled: false }),
      makeCronJob({ id: "session", sessionKey: "agent:research:main", enabled: false }),
      makeCronJob({ id: "sql-owner", enabled: false }),
    ],
  });
  const db = openOpenClawStateDatabase().db;
  db.prepare(
    "UPDATE cron_jobs SET agent_id = 'research' WHERE store_key = ? AND job_id = 'sql-owner'",
  ).run(cronStoreKey(storePath));
  db.prepare(
    "UPDATE cron_jobs SET job_json = json_set(job_json, '$.authoredNote', 'keep me') WHERE store_key = ? AND job_id = 'historical'",
  ).run(cronStoreKey(storePath));
}

function rows(storePath: string) {
  return loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
}

async function backups() {
  const databasePath = openOpenClawStateDatabase().path;
  return (await fs.readdir(path.dirname(databasePath)))
    .filter((name) => name.startsWith(`${path.basename(databasePath)}.doctor-cron-`))
    .map((name) => path.join(path.dirname(databasePath), name));
}

async function repair(state: OpenClawTestState) {
  return withDoctorConfigMaintenance(async () => {
    const ctx = await prepareDoctorContext(state.configPath);
    await runInitialConfigWriteHealth(ctx);
    return ctx;
  });
}

function createCron(storePath: string, defaultAgentId?: string) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const execute = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    scheduler,
    storePath,
    cronEnabled: true,
    nowMs: clock.clock.now,
    defaultAgentId,
    resolveDefaultAgentId: () => defaultAgentId,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: () => false,
    requestHeartbeat() {},
    runIsolatedAgentJob: execute,
  });
  return { cron, scheduler, execute, clock };
}

it.each(["retains", "removes"])(
  "refuses an ordinary roster write that %s the historical agent without changing its jobs",
  async (agentChange) => {
    await withOpenClawTestState(
      { label: "cron-owner-config-refusal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config = sourceConfig();
        await state.writeConfig({
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents.defaults,
              ...(agentChange === "removes" ? { authInheritance: { agentId: "research" } } : {}),
            },
          },
        });
        const storePath = state.statePath("cron", "jobs.json");
        await seedJobs(storePath);
        const beforeRows = rows(storePath);
        const beforeConfig = await fs.readFile(state.configPath, "utf8");
        const write = transformConfigFile({
          transform: (current) => {
            const canonical = createCanonicalAgentConfigFixture(current).config;
            return {
              nextConfig:
                agentChange === "removes" ? pruneAgentConfig(canonical, "ops").config : canonical,
            };
          },
          writeOptions: {
            persistCanonicalAgentRoster: true,
            ...(agentChange === "removes" ? { allowedAgentRosterRemovals: ["ops"] } : {}),
          },
          afterWrite: { mode: "none", reason: "test roster write" },
        });
        await expect(
          write,
          "Ordinary config writes must leave legacy ownership for Doctor",
        ).rejects.toMatchObject({
          code: "CONFIG_WRITE_REJECTED",
          refusal: "cron-owner-safety",
        });
        await expect(write).rejects.toThrow("openclaw doctor --fix");
        expect(rows(storePath)).toEqual(beforeRows);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
        expect(await backups()).toEqual([]);
      },
    );
  },
);

it.each(["update", "remove"])(
  "refuses an operator %s before changing an unresolved historical job",
  async (operation) => {
    await withOpenClawTestState(
      { label: "cron-owner-mutation-refusal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig(sourceConfig());
        const storePath = state.statePath("cron", "jobs.json");
        await seedJobs(storePath);
        const { cron } = createCron(storePath);
        try {
          expect(
            (await cron.list({ includeDisabled: true })).some((job) => job.id === "historical"),
          ).toBe(true);
          const beforeRows = rows(storePath);
          const operationResult =
            operation === "update"
              ? cron.update("historical", { name: "changed" })
              : cron.remove("historical");
          await expect(operationResult).rejects.toThrow(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
          expect(rows(storePath)).toEqual(beforeRows);
          expect(await backups()).toEqual([]);
        } finally {
          cron.stop();
        }
      },
    );
  },
);

it("preserves historical and explicit jobs when agent deletion needs Doctor", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-agent-deletion", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [
          makeCronJob({ id: "historical", enabled: false }),
          makeCronJob({ id: "research", agentId: "research", enabled: false }),
        ],
      });
      const { cron } = createCron(storePath);
      try {
        await cron.list({ includeDisabled: true });
        const beforeRows = rows(storePath);
        const beforeConfig = await fs.readFile(state.configPath, "utf8");
        await expect(
          cron.removeAgentJobsTransactional("research", () =>
            transformConfigFile({
              transform: (current) => ({
                nextConfig: pruneAgentConfig(
                  createCanonicalAgentConfigFixture(current).config,
                  "research",
                ).config,
              }),
              writeOptions: { allowedAgentRosterRemovals: ["research"] },
              afterWrite: { mode: "none", reason: "test agent deletion" },
            }),
          ),
        ).rejects.toMatchObject({ code: "CONFIG_WRITE_REJECTED", refusal: "cron-owner-safety" });
        expect(rows(storePath)).toEqual(beforeRows);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
        expect(await backups()).toEqual([]);
      } finally {
        cron.stop();
      }
    },
  );
});

it("preserves malformed cron bytes and the historical marker when Doctor cannot verify ownership", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-corrupt", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      await seedJobs(storePath);
      openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE cron_jobs SET job_json = '{malformed' WHERE store_key = ? AND job_id = 'historical'",
        )
        .run(cronStoreKey(storePath));
      const before = rows(storePath);
      const beforeConfig = await fs.readFile(state.configPath, "utf8");
      await expect(repair(state)).rejects.toThrow("Cannot verify ownership of malformed cron job");
      expect(rows(storePath)).toEqual(before);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(beforeConfig);
      expect(await backups()).toEqual([]);
    },
  );
});

it("leaves SQLite owners unchanged on ordinary cron startup", async () => {
  await withOpenClawTestState({ label: "cron-owner-startup" }, async (state) => {
    await state.writeConfig(sourceConfig());
    const storePath = state.statePath("cron", "jobs.json");
    await seedJobs(storePath);
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', 123), job_json = json_set(job_json, '$.notify', json('true')) WHERE store_key = ? AND job_id = 'sql-owner'",
      )
      .run(cronStoreKey(storePath));
    const beforeDefinitions = rows(storePath).map(({ job_id, job_json, agent_id }) => ({
      job_id,
      job_json,
      agent_id,
    }));
    const { cron, scheduler, execute } = createCron(storePath);
    try {
      await cron.start();
      expect(
        rows(storePath).map(({ job_id, job_json, agent_id }) => ({ job_id, job_json, agent_id })),
        "Gateway startup must not repair stored cron ownership",
      ).toEqual(beforeDefinitions);
      expect(
        JSON.parse(
          expectDefined(
            rows(storePath).find((row) => row.job_id === "sql-owner"),
            "SQL-owned job after runtime maintenance",
          ).state_json,
        ).nextRunAtMs,
      ).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(await backups()).toEqual([]);
    } finally {
      cron.stop();
      await scheduler.stop();
    }
  });
});

it("preserves a due legacy one-shot through Doctor ownership repair, then runs it once", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-one-shot", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      const dueAt = Date.now() - 1_000;
      await saveCronJobsStore(storePath, {
        version: 1,
        jobs: [
          makeCronJob({
            id: "pending-one-shot",
            enabled: true,
            deleteAfterRun: false,
            schedule: { kind: "at", at: new Date(dueAt).toISOString() },
            payload: { kind: "agentTurn", message: "Run after owner repair", toolsAllow: [] },
            state: { nextRunAtMs: dueAt },
          }),
        ],
      });
      const original = rows(storePath);
      expect((await readConfigFileSnapshot()).valid).toBe(false);
      expect(rows(storePath)).toEqual(original);
      const readReceipts = () =>
        openOpenClawStateDatabase()
          .db.prepare(
            "SELECT status FROM cron_run_receipts WHERE job_id = 'pending-one-shot' ORDER BY started_at_ms",
          )
          .all();
      expect(readReceipts()).toEqual([]);
      await repair(state);
      expect(await backups()).toHaveLength(1);
      const repaired = createCron(storePath, "research");
      try {
        await repaired.cron.start();
        expect(repaired.execute).not.toHaveBeenCalled();
        expect(readReceipts()).toEqual([]);
        const nextWakeAtMs = expectDefined(
          (await repaired.cron.status()).nextWakeAtMs,
          "repaired one-shot catch-up wake",
        );
        expect(nextWakeAtMs).toBeGreaterThan(repaired.clock.clock.now());
        await repaired.clock.advanceTo(nextWakeAtMs);
        expect(repaired.execute).toHaveBeenCalledOnce();
        expect(repaired.cron.getJob("pending-one-shot")).toMatchObject({
          agentId: "ops",
          enabled: false,
          state: { lastRunStatus: "ok" },
        });
        expect(readReceipts()).toEqual([{ status: "ok" }]);
        repaired.cron.stop();
        await repaired.cron.start();
        expect(repaired.execute).toHaveBeenCalledOnce();
        expect(readReceipts()).toEqual([{ status: "ok" }]);
      } finally {
        repaired.cron.stop();
        await repaired.scheduler.stop();
      }
    },
  );
});

it.each([
  { name: "missing", mode: undefined, expected: "announce" },
  { name: "null", mode: null, expected: "announce" },
  { name: "retired alias", mode: "deliver", expected: "announce" },
  { name: "announce casing", mode: " ANNOUNCE ", expected: "announce" },
  { name: "none casing", mode: " NoNe ", expected: "none" },
  { name: "webhook casing", mode: " WeBhOoK ", expected: "webhook" },
])(
  "keeps $name delivery visible and requires Doctor before execution",
  async ({ mode, expected }) => {
    await withOpenClawTestState(
      { label: "cron-delivery-doctor", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        await state.writeConfig(sourceConfig());
        const storePath = state.statePath("cron", "jobs.json");
        await saveCronJobsStore(storePath, {
          version: 1,
          jobs: [
            makeCronJob({
              id: "delivery-repair",
              agentId: "ops",
              schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
              payload: { kind: "agentTurn", message: "synthetic delivery repair", toolsAllow: [] },
              delivery: { mode: "announce" },
              state: { lastRunAtMs: 123, lastRunStatus: "ok" },
            }),
          ],
        });
        const db = openOpenClawStateDatabase().db;
        const definition = JSON.parse(rows(storePath)[0]!.job_json);
        definition.delivery = {
          ...(mode === undefined ? {} : { mode }),
          to: expected === "webhook" ? "https://example.invalid/hook" : "synthetic-target",
          ...(expected === "webhook" ? {} : { channel: "telegram" }),
        };
        definition.authoredNote = "preserve this definition";
        db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
          JSON.stringify(definition),
          cronStoreKey(storePath),
          "delivery-repair",
        );
        const original = rows(storePath);
        const { cron, scheduler, execute } = createCron(storePath);
        try {
          await cron.start();
          expect(cron.getJob("delivery-repair")?.delivery).toEqual(definition.delivery);
          await expect(cron.run("delivery-repair", "force")).rejects.toThrow(
            "delivery requires an explicit mode",
          );
          expect(execute).not.toHaveBeenCalled();
          expect(rows(storePath).map(({ job_json, agent_id }) => ({ job_json, agent_id }))).toEqual(
            original.map(({ job_json, agent_id }) => ({ job_json, agent_id })),
          );
          expect(await backups()).toEqual([]);
          const beforeDoctor = rows(storePath);

          const ctx = await repair(state);
          if (mode === undefined) {
            const snapshot = vi
              .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
              .mockRejectedValueOnce(new Error("synthetic backup failure"));
            try {
              await withDoctorConfigMaintenance(() =>
                maybeRepairLegacyCronStore({
                  cfg: ctx.cfg,
                  options: ctx.options,
                  prompter: ctx.prompter,
                }),
              );
              expect(snapshot).toHaveBeenCalledOnce();
              expect(rows(storePath)).toEqual(beforeDoctor);
              expect(await backups()).toEqual([]);
            } finally {
              snapshot.mockRestore();
            }
          }
          await withDoctorConfigMaintenance(() =>
            maybeRepairLegacyCronStore({
              cfg: ctx.cfg,
              options: ctx.options,
              prompter: ctx.prompter,
            }),
          );
          const repaired = rows(storePath)[0]!;
          expect(JSON.parse(repaired.job_json)).toMatchObject({
            agentId: "ops",
            authoredNote: "preserve this definition",
            delivery: { ...definition.delivery, mode: expected },
          });
          expect(repaired.state_json).toBe(beforeDoctor[0]!.state_json);
          expect(repaired.sort_order).toBe(original[0]!.sort_order);
          const savedBackups = await backups();
          expect(savedBackups).toHaveLength(1);
          const backup = new DatabaseSync(savedBackups[0]!, { readOnly: true });
          try {
            expect(loadCronRows(backup, cronStoreKey(storePath))).toEqual(beforeDoctor);
          } finally {
            backup.close();
          }
          await withDoctorConfigMaintenance(() =>
            maybeRepairLegacyCronStore({
              cfg: ctx.cfg,
              options: ctx.options,
              prompter: ctx.prompter,
            }),
          );
          expect(rows(storePath)).toEqual([repaired]);
          await cron.start();
          expect(cron.getJob("delivery-repair")?.delivery?.mode).toBe(expected);
          await expect(cron.run("delivery-repair", "force")).resolves.toEqual({
            ok: true,
            ran: true,
          });
          expect(execute).toHaveBeenCalledOnce();
        } finally {
          cron.stop();
          await scheduler.stop();
        }
      },
    );
  },
);

it.each([
  "health write",
  "preflight custom store",
  "health write with unsupported delivery",
  "legacy list with a machine-state custom store",
])("pins the original owner before the %s and preserves recovery", async (entry) => {
  await withOpenClawTestState(
    { label: "cron-owner-doctor", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const machineStore = entry === "legacy list with a machine-state custom store";
      const customStore = entry === "preflight custom store" || machineStore;
      const storePath = state.statePath(customStore ? "custom-cron" : "cron", "jobs.json");
      const config = sourceConfig(customStore && !machineStore ? storePath : undefined);
      await state.writeConfig(
        machineStore
          ? {
              ...config,
              agents: {
                defaults: config.agents.defaults,
                list: [{ id: "ops", default: true }, { id: "research" }],
              },
            }
          : config,
      );
      if (machineStore) {
        writeConfigMachineState("cron.store", storePath);
      }
      await seedJobs(storePath);
      const oldWriterRecreation = entry === "health write";
      const retainedGrantGeneration = 40;
      if (oldWriterRecreation) {
        const db = openOpenClawStateDatabase().db;
        db.prepare(
          `INSERT INTO operator_approvals (
             approval_id, resolution_ref, kind, status, presentation_json,
             reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
             created_at_ms, expires_at_ms, updated_at_ms, decision, terminal_reason,
             resolved_at_ms, resolver_kind
           ) VALUES ('historical-approval', ?, 'exec', 'allowed', '{}', '[]', '[]',
                     'historical-epoch', 1, 3, 2, 'allow-always', 'user', 2, 'device')`,
        ).run("a".repeat(43));
        const historical = expectDefined(
          loadedCronStoreFromRows(rows(storePath)).store.jobs.find(
            (job) => job.id === "historical",
          ),
          "historical cron job",
        );
        runOpenClawStateWriteTransaction((database) =>
          mintCronStandingGrantLocked(database, {
            approvalId: "historical-approval",
            agentId: "ops",
            cronJobId: "historical",
            jobConfigRevision: resolveCronJobConfigRevision(historical),
            operationBinding: "historical-operation",
            nowMs: 2,
            expiresAtMs: null,
          }),
        );
        db.prepare(
          `UPDATE operator_approval_standing_grant_generations
           SET job_definition_generation = ?
           WHERE grant_id = (SELECT grant_id FROM operator_approval_standing_grants
                             WHERE minted_by_approval_id = 'historical-approval')`,
        ).run(retainedGrantGeneration);
        // A released writer recreates the row without the additive generation projections.
        const releasedColumns =
          "store_key, job_id, declaration_key, owner_agent_id, name, description, enabled, agent_id, payload_kind, job_json, state_json, runtime_updated_at_ms, schedule_identity, sort_order, updated_at";
        db.prepare(
          `CREATE TEMP TABLE old_writer_cron_row AS SELECT ${releasedColumns} FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'`,
        ).run(cronStoreKey(storePath));
        db.prepare("DELETE FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'").run(
          cronStoreKey(storePath),
        );
        db.exec(
          `INSERT INTO cron_jobs (${releasedColumns}) SELECT ${releasedColumns} FROM old_writer_cron_row`,
        );
        db.exec("DROP TABLE old_writer_cron_row");
      }
      const otherStorePath = state.statePath("other-cron", "jobs.json");
      if (machineStore) {
        await saveCronJobsStore(otherStorePath, {
          version: 1,
          jobs: [makeCronJob({ id: "other-ownerless", enabled: false })],
        });
      }
      const readOtherRows = () =>
        openOpenClawStateDatabase()
          .db.prepare("SELECT * FROM cron_jobs WHERE store_key = ? ORDER BY sort_order, job_id")
          .all(cronStoreKey(otherStorePath));
      const otherRowsBefore = machineStore ? readOtherRows() : undefined;
      const unsupportedDelivery = entry === "health write with unsupported delivery";
      if (unsupportedDelivery) {
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery.mode', 'not-a-route') WHERE store_key = ? AND job_id = 'historical'",
          )
          .run(cronStoreKey(storePath));
      }
      const original = rows(storePath);
      const originalGrant = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT grant_definition_generation FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'",
        )
        .get(cronStoreKey(storePath));
      const ctx = await repair(state);
      expect(ctx.configWriteRefusal).toBeUndefined();
      const saved = await readConfigFileSnapshot();
      expect(saved.config.agents?.ownership).toBe("explicit");
      expect(saved.config.agents?.defaults?.systemAgent?.agentId).toBe("research");
      expect(saved.sourceConfig.agents?.entries?.ops).not.toHaveProperty("default");
      const repaired = rows(storePath);
      const historical = repaired.find((row) => row.job_id === "historical");
      const originalHistorical = original.find((row) => row.job_id === "historical");
      expect(historical).toMatchObject({
        agent_id: "ops",
        state_json: originalHistorical?.state_json,
        sort_order: originalHistorical?.sort_order,
      });
      expect(JSON.parse(historical?.job_json ?? "null")).toMatchObject({
        agentId: "ops",
        authoredNote: "keep me",
        ...(unsupportedDelivery ? { delivery: { mode: "not-a-route" } } : {}),
      });
      const repairedGrant = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT grant_definition_generation, grant_definition_revision, grant_definition_updated_at FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'",
        )
        .get(cronStoreKey(storePath));
      expect(repairedGrant?.grant_definition_generation).toBeGreaterThan(
        Number(originalGrant?.grant_definition_generation),
      );
      expect(repairedGrant?.grant_definition_revision).toBeNull();
      expect(repairedGrant?.grant_definition_updated_at).toBeNull();
      if (oldWriterRecreation) {
        expect(originalGrant?.grant_definition_generation).toBeNull();
        expect(repairedGrant?.grant_definition_generation).toBe(retainedGrantGeneration + 1);
        expect(
          openOpenClawStateDatabase()
            .db.prepare(
              `SELECT grants.revoked_at_ms, generations.job_definition_generation
               FROM operator_approval_standing_grants AS grants
               JOIN operator_approval_standing_grant_generations AS generations USING (grant_id)
               WHERE grants.minted_by_approval_id = 'historical-approval'`,
            )
            .get(),
        ).toEqual({ revoked_at_ms: null, job_definition_generation: retainedGrantGeneration });
      }
      for (const id of ["explicit", "session", "sql-owner"]) {
        const row = repaired.find((candidate) => candidate.job_id === id);
        const before = original.find((candidate) => candidate.job_id === id);
        if (!customStore && id !== "sql-owner") {
          expect(row).toEqual(before);
        } else {
          expect(row?.state_json).toBe(before?.state_json);
          expect(row?.agent_id).toBe(before?.agent_id);
        }
      }
      expect(
        JSON.parse(repaired.find((row) => row.job_id === "sql-owner")?.job_json ?? "null"),
      ).toMatchObject({ agentId: "research" });
      if (machineStore) {
        expect(saved.sourceConfig.agents).not.toHaveProperty("list");
        expect(readOtherRows()).toEqual(otherRowsBefore);
      }
      const savedBackups = await backups();
      expect(savedBackups).toHaveLength(1);
      const backedUpRows = savedBackups.map((backupPath) => {
        const backup = new DatabaseSync(backupPath, { readOnly: true });
        try {
          expect(backup.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
          expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          return loadCronRows(backup, cronStoreKey(storePath));
        } finally {
          backup.close();
        }
      });
      expect(backedUpRows).toEqual([original]);
      const repairedDefinitions = rows(storePath);
      await repair(state);
      expect(rows(storePath)).toEqual(repairedDefinitions);
      expect(await backups()).toEqual(savedBackups);
      if (machineStore) {
        expect(readOtherRows()).toEqual(otherRowsBefore);
      }
    },
  );
});

it("retains the marker and a verified backup when SQL ownership changes after inspection", async () => {
  await withOpenClawTestState(
    { label: "cron-owner-currentness", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      await state.writeConfig(sourceConfig());
      const storePath = state.statePath("cron", "jobs.json");
      await seedJobs(storePath);
      const originalConfig = await fs.readFile(state.configPath, "utf8");
      const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
      const snapshot = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockImplementationOnce(async (params) => {
          const result = await createSnapshot(params);
          openOpenClawStateDatabase()
            .db.prepare(
              "UPDATE cron_jobs SET agent_id = 'research' WHERE store_key = ? AND job_id = 'historical'",
            )
            .run(cronStoreKey(storePath));
          return result;
        });
      await expect(repair(state)).rejects.toThrow("Cron ownership changed during Doctor repair");
      snapshot.mockRestore();
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
      const historical = rows(storePath).find((row) => row.job_id === "historical");
      expect(historical?.agent_id).toBe("research");
      expect(JSON.parse(historical?.job_json ?? "null")).not.toHaveProperty("agentId");
      expect(await backups()).toHaveLength(1);
    },
  );
});
