import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryCore from "../../extensions/memory-core/index.js";
import type { OpenClawConfig } from "../../src/config/types.js";
import { CronService, type CronEvent } from "../../src/cron/service.js";
import { createNoopLogger } from "../../src/cron/service.test-harness.js";
import {
  getCronJobsStoreRevision,
  saveCronJobsStoreWithRevisionNative,
} from "../../src/cron/store.js";
import { inspectCronJobsForDoctor, repairCronJobsForDoctor } from "../../src/cron/store/doctor.js";
import type { CronStoredJob } from "../../src/cron/types.js";
import * as sqliteSnapshot from "../../src/infra/sqlite-snapshot.js";
import { createPluginDoctorStateMigrationContext } from "../../src/infra/state-migrations.plugin-doctor-context.js";
import type { PluginDoctorRepairAuthority } from "../../src/infra/state-migrations.types.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import type {
  PluginDoctorCronInventory,
  PluginDoctorCronJob,
} from "../../src/plugins/doctor-contract-module.js";
import { listPluginDoctorStateMigrationEntries } from "../../src/plugins/doctor-contract-registry.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry.js";
import { startPluginServices, type PluginServicesHandle } from "../../src/plugins/services.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../src/state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";

afterEach(() => vi.restoreAllMocks());

function makeJob(id: string, fields: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id,
    name: `Operator ${id}`,
    enabled: false,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_005,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "operator event" },
    state: { nextRunAtMs: 1_800_000_060_000, lastRunStatus: "ok" },
    runtimeAuthorityRecoveryRequired: true,
    ...fields,
  };
}

function readRows(db: DatabaseSync) {
  return {
    jobs: db.prepare("SELECT * FROM cron_jobs ORDER BY store_key, job_id").all(),
    scratch: db.prepare("SELECT * FROM cron_job_scratch ORDER BY store_key, job_id").all(),
    authority: db
      .prepare("SELECT * FROM cron_job_runtime_authorities ORDER BY store_key, job_id")
      .all(),
  };
}

type Fixture = {
  state: OpenClawTestState;
  scope: { config: OpenClawConfig; env: NodeJS.ProcessEnv };
  activeStore: string;
  retiredStore: string;
  untouchedStore: string;
  databasePath: string;
  db: () => DatabaseSync;
};

async function withCronFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { activeDreaming?: boolean; additionalActiveJobs?: CronStoredJob[] } = {},
) {
  await withOpenClawTestState({ label: "cron-doctor" }, async (state) => {
    const activeStore = state.statePath("cron", "jobs.json");
    const retiredStore = state.statePath("retired", "cron", "jobs.json");
    const untouchedStore = state.statePath("operator", "jobs.json");
    const legacyFields: Partial<CronStoredJob> = {
      name: "Memory Dreaming Promotion",
      description: "[managed-by=memory-core.short-term-promotion] legacy",
      payload: {
        kind: "systemEvent",
        text: "__openclaw_memory_core_short_term_promotion_dream__",
      },
    };
    for (const [storePath, jobs] of [
      [
        activeStore,
        [
          ...(options.activeDreaming === false
            ? []
            : [
                makeJob("survivor", legacyFields),
                makeJob("duplicate", { ...legacyFields, createdAtMs: 1_800_000_000_100 }),
              ]),
          makeJob("operator", {
            schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
          }),
          ...(options.additionalActiveJobs ?? []),
        ],
      ],
      [retiredStore, [makeJob("retired", legacyFields), makeJob("malformed")]],
      [untouchedStore, [makeJob("survivor")]],
    ] as const) {
      saveCronJobsStoreWithRevisionNative(storePath, { version: 1, jobs: [...jobs] });
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare("UPDATE cron_jobs SET sort_order = 17 WHERE store_key = ? AND job_id = ?").run(
        activeStore,
        "survivor",
      );
      const operator = db
        .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(activeStore, "operator");
      db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
        ` \n${String(operator?.job_json)}\n `,
        activeStore,
        "operator",
      );
      db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
        "{ malformed legacy definition",
        retiredStore,
        "malformed",
      );
      db.exec(`INSERT INTO cron_job_scratch (store_key, job_id, content, revision, updated_at_ms)
        SELECT store_key, job_id, 'scratch:' || job_id, 3, 1800000000000 FROM cron_jobs`);
    });
    await run({
      state,
      scope: { config: {}, env: state.env },
      activeStore,
      retiredStore,
      untouchedStore,
      databasePath: resolveOpenClawStateSqlitePath(state.env),
      db: () => openOpenClawStateDatabase({ env: state.env }).db,
    });
  });
}

function findJob(inventory: PluginDoctorCronInventory, storeKey: string, id: string) {
  const job = inventory.jobs.find((row) => row.storeKey === storeKey && row.id === id);
  if (!job) {
    throw new Error(`Missing fixture row ${storeKey}:${id}`);
  }
  return job;
}

function changeDescription(job: PluginDoctorCronJob) {
  if (!job.definition) {
    throw new Error("Expected a valid fixture definition");
  }
  return { job, definition: { ...job.definition, description: "Doctor repaired definition" } };
}

function makeAuthority(): PluginDoctorRepairAuthority {
  return {
    assertCurrent() {},
    assertOwnedInTransaction(db) {
      expect(db.isTransaction).toBe(true);
    },
  };
}

function getDreamingMigration({ scope }: Fixture) {
  const entry = listPluginDoctorStateMigrationEntries({
    ...scope,
    pluginIds: ["memory-core"],
  }).find(({ migration }) => migration.id === "memory-core-dreaming-cron");
  if (!entry) {
    throw new Error("Missing registered memory-core dreaming cron migration");
  }
  return entry.migration;
}

function migrationInput({ state, scope }: Fixture) {
  return {
    ...scope,
    stateDir: state.stateDir,
    oauthDir: state.statePath("credentials"),
    context: createPluginDoctorStateMigrationContext({
      ...scope,
      pluginId: "memory-core",
      trustedForDurableStores: true,
      repairAuthority: makeAuthority(),
    }),
  };
}

function createPausedCronService(fixture: Fixture) {
  const logger = createNoopLogger();
  const mutations: Array<Pick<CronEvent, "jobId" | "action">> = [];
  const cron = new CronService({
    storePath: fixture.activeStore,
    cronEnabled: true,
    defaultAgentId: "main",
    log: logger,
    nowMs: () => 1_800_000_000_200,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent(event) {
      if (event.action === "added" || event.action === "updated" || event.action === "removed") {
        mutations.push({ jobId: event.jobId, action: event.action });
      }
    },
  });
  // CRUD can arm an unstarted service; suspend automatic ticks during convergence proof.
  cron.pauseScheduling();
  return { cron, logger, mutations };
}

async function runRegisteredDreamingService(
  config: OpenClawConfig,
  cron: CronService,
  logger: ReturnType<typeof createNoopLogger>,
) {
  const registry = createEmptyPluginRegistry();
  memoryCore.register(
    createTestPluginApi({
      id: "memory-core",
      config,
      logger,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerService(service) {
        registry.services.push({
          pluginId: "memory-core",
          origin: "bundled",
          source: "memory-core/index.ts",
          id: service.id,
          service,
        });
      },
    }),
  );
  if (!registry.services.some(({ id }) => id === "memory-core-dreaming")) {
    throw new Error("Memory Core did not register its dreaming service");
  }
  let services: PluginServicesHandle | undefined;
  try {
    services = await startPluginServices({
      registry,
      config,
      getCronService: () => cron,
      throwOnStartError: true,
      onHandle(handle) {
        services = handle;
      },
    });
    expect(logger.error).not.toHaveBeenCalled();
  } finally {
    await services?.stop({ strict: true });
  }
}

function afterBackup(callback: () => void) {
  const actual = sqliteSnapshot.createVerifiedSqliteSnapshot;
  return vi
    .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
    .mockImplementation(async (input) => {
      const result = await actual(input);
      callback();
      return result;
    });
}

async function listBackups(databasePath: string) {
  const prefix = `${path.basename(databasePath)}.doctor-cron-`;
  return (await fs.readdir(path.dirname(databasePath)))
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(path.dirname(databasePath), name))
    .toSorted();
}

function revisions(fixture: Fixture) {
  return {
    active: getCronJobsStoreRevision(fixture.activeStore),
    retired: getCronJobsStoreRevision(fixture.retiredStore),
    untouched: getCronJobsStoreRevision(fixture.untouchedStore),
  };
}

describe("host Cron Doctor repair", () => {
  it("inspects absent and pre-cron databases without creating or migrating state", async () => {
    await withOpenClawTestState({ label: "cron-doctor-absent" }, async (state) => {
      const scope = { config: {}, env: state.env };
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const before = await fs.readdir(state.stateDir);
      await expect(inspectCronJobsForDoctor(scope)).resolves.toEqual({
        jobs: [],
      });
      expect(await fs.readdir(state.stateDir)).toEqual(before);
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });

      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      const legacy = new DatabaseSync(databasePath);
      legacy.exec("CREATE TABLE legacy_marker(value TEXT); PRAGMA user_version = 1");
      legacy.close();
      const bytes = await fs.readFile(databasePath);
      expect((await inspectCronJobsForDoctor(scope)).jobs).toEqual([]);
      expect(await fs.readFile(databasePath)).toEqual(bytes);
    });
  });

  it("includes inactive partitions and malformed definitions without repairing any row", async () => {
    await withCronFixture(async (fixture) => {
      const before = readRows(fixture.db());
      await closeOpenClawStateDatabaseAsync();
      const bytes = await fs.readFile(fixture.databasePath);
      const databaseDir = path.dirname(fixture.databasePath);
      const entries = (await fs.readdir(databaseDir)).toSorted();
      const inventory = await inspectCronJobsForDoctor(fixture.scope);
      expect(inventory.jobs).toHaveLength(6);
      expect(findJob(inventory, fixture.activeStore, "survivor").sortOrder).toBe(17);
      expect(findJob(inventory, fixture.untouchedStore, "survivor").definition).toMatchObject({
        name: "Operator survivor",
      });
      expect(findJob(inventory, fixture.retiredStore, "malformed")).toMatchObject({
        definitionJson: "{ malformed legacy definition",
        definition: null,
      });
      expect(await fs.readFile(fixture.databasePath)).toEqual(bytes);
      expect((await fs.readdir(databaseDir)).toSorted()).toEqual(entries);
      expect(readRows(fixture.db())).toEqual(before);
    });
  });

  it("runs the registered memory-core migration with recoverable backup and an idempotent second pass", async () => {
    await withCronFixture(async (fixture) => {
      const { state, activeStore, retiredStore, databasePath } = fixture;
      const migration = getDreamingMigration(fixture);
      saveCronJobsStoreWithRevisionNative(fixture.untouchedStore, {
        version: 1,
        jobs: [
          makeJob("survivor"),
          makeJob("authored-phase", {
            name: "Operator-authored workflow",
            description:
              "[managed-by=memory-core.dreaming.light] [managed-by=memory-core.short-term-promotion] operator note",
            sessionTarget: "isolated",
            payload: {
              kind: "agentTurn",
              message: "Summarize workspace activity and draft tomorrow's priorities.",
            },
            delivery: { mode: "none" },
          }),
          makeJob("authored-unified", {
            name: "Operator-authored review",
            description: "[managed-by=memory-core.short-term-promotion] operator note",
            sessionTarget: "isolated",
            payload: {
              kind: "agentTurn",
              message: "Review the project notes and prepare questions for tomorrow's meeting.",
            },
            delivery: { mode: "none" },
          }),
        ],
      });
      const input = migrationInput(fixture);
      const before = readRows(fixture.db());
      const previousRevisions = revisions(fixture);
      expect(await migration.detectLegacyState(input)).not.toBeNull();
      expect(readRows(fixture.db())).toEqual(before);
      const runtimeJson = '{ "nextRunAtMs": 1800000999999, "lastRunStatus": "error" }';
      afterBackup(() => {
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(`UPDATE cron_jobs SET state_json = ?, runtime_updated_at_ms = 1800000000999
            WHERE store_key = ? AND job_id = 'survivor'`).run(runtimeJson, activeStore);
        });
      });
      const result = await migration.migrateLegacyState(input);
      expect(result.changes.length).toBeGreaterThan(0);
      const backups = await listBackups(databasePath);
      expect(backups).toHaveLength(1);
      const backupPath = backups[0];
      if (!backupPath) {
        throw new Error("Migration did not retain its backup");
      }
      expect(result.changes.join("\n")).toContain(backupPath);
      const after = readRows(fixture.db());
      const survivor = after.jobs.find(
        (row) => row.store_key === activeStore && row.job_id === "survivor",
      );
      expect(survivor).toMatchObject({
        job_id: "survivor",
        sort_order: 17,
        state_json: runtimeJson,
        runtime_updated_at_ms: 1_800_000_000_999,
      });
      expect(JSON.parse(String(survivor?.job_json))).toMatchObject({
        id: "survivor",
        declarationKey: "memory-core:memory-dreaming-promotion",
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", lightContext: true },
        delivery: { mode: "none" },
      });
      const inactiveSurvivor = after.jobs.find(
        (row) => row.store_key === retiredStore && row.job_id === "retired",
      );
      const previousInactiveSurvivor = before.jobs.find(
        (row) => row.store_key === retiredStore && row.job_id === "retired",
      );
      expect(inactiveSurvivor).toMatchObject({
        store_key: retiredStore,
        job_id: "retired",
        sort_order: previousInactiveSurvivor?.sort_order,
        state_json: previousInactiveSurvivor?.state_json,
        runtime_updated_at_ms: previousInactiveSurvivor?.runtime_updated_at_ms,
      });
      expect(JSON.parse(String(inactiveSurvivor?.job_json))).toMatchObject({
        declarationKey: "memory-core:memory-dreaming-promotion",
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", lightContext: true },
        delivery: { mode: "none" },
      });
      const unaffected = (row: Record<string, unknown>) =>
        !(
          row.store_key === activeStore && ["survivor", "duplicate"].includes(String(row.job_id))
        ) && !(row.store_key === retiredStore && row.job_id === "retired");
      for (const table of ["jobs", "scratch", "authority"] as const) {
        expect(after[table].filter(unaffected)).toEqual(before[table].filter(unaffected));
        expect(
          after[table].some((row) => row.store_key === activeStore && row.job_id === "duplicate"),
        ).toBe(false);
      }
      expect(after.scratch.filter((row) => row.store_key === activeStore)).toEqual(
        before.scratch.filter((row) => row.store_key === activeStore && row.job_id !== "duplicate"),
      );
      expect(after.scratch.filter((row) => row.store_key === retiredStore)).toEqual(
        before.scratch.filter((row) => row.store_key === retiredStore),
      );
      const committedRevisions = revisions(fixture);
      expect(committedRevisions.active).toBeGreaterThan(previousRevisions.active);
      expect(committedRevisions.retired).toBeGreaterThan(previousRevisions.retired);
      expect(committedRevisions.untouched).toBe(previousRevisions.untouched);

      const recoveredPath = state.path("recovered.sqlite");
      await fs.copyFile(backupPath, recoveredPath);
      const recovered = new DatabaseSync(recoveredPath, { readOnly: true });
      try {
        expect(readRows(recovered)).toEqual(before);
      } finally {
        recovered.close();
      }
      const remaining = await migration.detectLegacyState(input);
      expect(remaining?.preview).toHaveLength(3);
      expect(remaining?.preview).toEqual(
        expect.arrayContaining([
          expect.stringContaining("malformed"),
          expect.stringMatching(/authored-phase.*review.*manually/),
          expect.stringMatching(/authored-unified.*review.*manually/),
        ]),
      );
      const second = await migration.migrateLegacyState(input);
      expect(second.changes).toEqual([]);
      expect(second.warnings).toEqual(remaining?.preview);
      expect(readRows(fixture.db())).toEqual(after);
      expect(await listBackups(databasePath)).toEqual(backups);
      expect(revisions(fixture)).toEqual(committedRevisions);
    });
  });

  it.each([true, false])(
    "repairs phase-only partitions with dreaming enabled=%s and retains their original backup",
    async (enabled) => {
      await withCronFixture(async (fixture) => {
        fixture.scope.config = {
          plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } },
        };
        const migration = getDreamingMigration(fixture);
        const phaseRows = [
          { store: fixture.activeStore, id: "survivor", phase: "light" },
          { store: fixture.activeStore, id: "duplicate", phase: "rem" },
          { store: fixture.retiredStore, id: "retired", phase: "rem" },
        ] as const;
        runOpenClawStateWriteTransaction(({ db }) => {
          const seedPhase = db.prepare(`UPDATE cron_jobs SET name = ?, description = ?,
            job_json = json_set(job_json, '$.name', ?, '$.description', ?,
              '$.payload', json(?), '$.delivery', json(?))
            WHERE store_key = ? AND job_id = ?`);
          for (const { store, id, phase } of phaseRows) {
            const name = phase === "light" ? "Memory Light Dreaming" : "Memory REM Dreaming";
            const description = `[managed-by=memory-core.dreaming.${phase}] keep operator note`;
            seedPhase.run(
              name,
              description,
              name,
              description,
              JSON.stringify({
                kind: "systemEvent",
                text: `__openclaw_memory_core_${phase === "light" ? "light" : "rem"}_sleep__`,
                timeoutSeconds: 90,
                toolsAllow: ["read"],
              }),
              JSON.stringify({ mode: "none", bestEffort: true }),
              store,
              id,
            );
          }
        });
        const before = readRows(fixture.db());
        const input = migrationInput(fixture);
        await migration.migrateLegacyState(input);
        const after = readRows(fixture.db());
        const selected = (row: Record<string, unknown>) =>
          phaseRows.some(({ store, id }) => row.store_key === store && row.job_id === id);
        const removed = (row: Record<string, unknown>) =>
          selected(row) && (!enabled || row.job_id === "duplicate");
        for (const table of ["jobs", "scratch", "authority"] as const) {
          expect(after[table].filter((row) => !selected(row))).toEqual(
            before[table].filter((row) => !selected(row)),
          );
          expect(after[table].some(removed)).toBe(false);
        }
        if (enabled) {
          for (const { store, id } of phaseRows.filter((row) => row.id !== "duplicate")) {
            const original = before.jobs.find(
              (row) => row.store_key === store && row.job_id === id,
            );
            const survivor = after.jobs.find((row) => row.store_key === store && row.job_id === id);
            expect(survivor).toMatchObject({
              store_key: store,
              job_id: id,
              sort_order: original?.sort_order,
              state_json: original?.state_json,
              runtime_updated_at_ms: original?.runtime_updated_at_ms,
            });
            const originalDefinition = JSON.parse(String(original?.job_json));
            const definition = JSON.parse(String(survivor?.job_json));
            expect(definition).toMatchObject({
              declarationKey: "memory-core:memory-dreaming-promotion",
              name: "Memory Dreaming Promotion",
              description: "[managed-by=memory-core.short-term-promotion] keep operator note",
              enabled: originalDefinition.enabled,
              createdAtMs: originalDefinition.createdAtMs,
              schedule: originalDefinition.schedule,
              wakeMode: originalDefinition.wakeMode,
              sessionTarget: "isolated",
              payload: {
                kind: "agentTurn",
                message: "__openclaw_memory_core_short_term_promotion_dream__",
                lightContext: true,
                timeoutSeconds: 90,
                toolsAllow: ["read"],
              },
              delivery: { mode: "none", bestEffort: true },
            });
            expect(definition.payload).not.toHaveProperty("text");
          }
          for (const table of ["scratch", "authority"] as const) {
            expect(after[table]).toEqual(before[table].filter((row) => !removed(row)));
          }
        } else {
          for (const table of ["jobs", "scratch", "authority"] as const) {
            expect(after[table]).toEqual(before[table].filter((row) => !selected(row)));
          }
        }
        const backups = await listBackups(fixture.databasePath);
        expect(backups).toHaveLength(1);
        const backupPath = backups[0];
        if (!backupPath) {
          throw new Error("Phase migration did not retain its backup");
        }
        const backup = new DatabaseSync(backupPath, { readOnly: true });
        try {
          expect(readRows(backup)).toEqual(before);
        } finally {
          backup.close();
        }
        expect((await migration.migrateLegacyState(input)).changes).toEqual([]);
        expect(readRows(fixture.db())).toEqual(after);
        expect(await listBackups(fixture.databasePath)).toEqual(backups);
      });
    },
  );

  it.each([
    { layout: "inactive only", activeDreaming: false, enabled: true },
    { layout: "active and inactive", activeDreaming: true, enabled: true },
    { layout: "inactive only", activeDreaming: false, enabled: false },
    { layout: "active and inactive", activeDreaming: true, enabled: false },
  ])(
    "keeps $layout history and authored lookalikes after Doctor and runtime dreaming enabled=$enabled",
    async ({ activeDreaming, enabled }) => {
      await withCronFixture(
        async (fixture) => {
          const { activeStore, retiredStore } = fixture;
          const migration = getDreamingMigration(fixture);
          const authoredPayloadOptions = { model: "openai/gpt-4.1-mini", timeoutSeconds: 90 };
          runOpenClawStateWriteTransaction(({ db }) => {
            db.prepare(`UPDATE cron_jobs SET payload_kind = 'agentTurn',
              job_json = json_set(job_json, '$.sessionTarget', 'isolated', '$.payload', json(?))
              WHERE (store_key = ? AND job_id = 'survivor')
                 OR (store_key = ? AND job_id = 'retired')`).run(
              JSON.stringify({
                kind: "agentTurn",
                message: "__openclaw_memory_core_short_term_promotion_dream__",
                ...authoredPayloadOptions,
              }),
              activeStore,
              retiredStore,
            );
          });
          const taggedBeforeDoctor = readRows(fixture.db()).jobs.find(
            (row) => row.store_key === activeStore && row.job_id === "authored-lookalike",
          );
          expect(taggedBeforeDoctor).toBeDefined();
          const migrated = await migration.migrateLegacyState(migrationInput(fixture));
          expect(migrated.changes.length).toBeGreaterThan(0);
          expect(migrated.warnings).toEqual(
            expect.arrayContaining([expect.stringMatching(/authored-lookalike.*review.*manually/)]),
          );
          const beforeRuntime = readRows(fixture.db());
          expect(
            beforeRuntime.jobs.filter(
              (row) => row.store_key === activeStore && row.job_id === "authored-lookalike",
            ),
          ).toEqual([taggedBeforeDoctor]);
          expect(
            beforeRuntime.jobs.filter(
              (row) =>
                row.store_key === activeStore &&
                JSON.parse(String(row.job_json)).declarationKey ===
                  "memory-core:memory-dreaming-promotion",
            ),
          ).toHaveLength(activeDreaming ? 1 : 0);
          const migratedSurvivors = beforeRuntime.jobs.filter(
            (row) =>
              (row.store_key === activeStore && row.job_id === "survivor") ||
              (row.store_key === retiredStore && row.job_id === "retired"),
          );
          expect(migratedSurvivors).toHaveLength(activeDreaming ? 2 : 1);
          for (const row of migratedSurvivors) {
            expect(JSON.parse(String(row.job_json)).payload).toMatchObject({
              kind: "agentTurn",
              message: "__openclaw_memory_core_short_term_promotion_dream__",
              lightContext: true,
              ...authoredPayloadOptions,
            });
          }
          const retiredRevision = getCronJobsStoreRevision(retiredStore);
          const inactive = (row: Record<string, unknown>) => row.store_key !== activeStore;
          const authoredBefore = beforeRuntime.jobs.find(
            (row) => row.store_key === activeStore && row.job_id === "operator",
          );
          const { cron, logger, mutations } = createPausedCronService(fixture);
          try {
            const config: OpenClawConfig = {
              plugins: {
                entries: {
                  "memory-core": {
                    config: { dreaming: { enabled, frequency: "15 4 * * *", timezone: "UTC" } },
                  },
                },
              },
            };
            await runRegisteredDreamingService(config, cron, logger);
            expect(mutations).toEqual(
              enabled
                ? [
                    {
                      jobId: activeDreaming ? "survivor" : expect.any(String),
                      action: activeDreaming ? "updated" : "added",
                    },
                  ]
                : activeDreaming
                  ? [{ jobId: "survivor", action: "removed" }]
                  : [],
            );
            expect(logger.warn).toHaveBeenCalledWith(
              expect.stringContaining(
                "cron jobs authored-lookalike retain historical dreaming tags",
              ),
            );
            const jobs = await cron.list({ includeDisabled: true });
            const managed = jobs.filter(
              (job) => job.declarationKey === "memory-core:memory-dreaming-promotion",
            );
            expect(managed).toHaveLength(enabled ? 1 : 0);
            if (enabled) {
              expect(managed[0]).toMatchObject({
                enabled: true,
                sessionTarget: "isolated",
                schedule: { kind: "cron", expr: "15 4 * * *", tz: "UTC" },
                payload: { kind: "agentTurn", lightContext: true },
                delivery: { mode: "none" },
              });
              if (activeDreaming) {
                expect(managed[0]?.id).toBe("survivor");
                expect(managed[0]?.payload).toMatchObject(authoredPayloadOptions);
              } else {
                expect(managed[0]?.id).not.toBe("retired");
              }
            }
            expect(jobs.some((job) => job.id === "operator")).toBe(true);
            const afterRuntime = readRows(fixture.db());
            const authoredAfter = afterRuntime.jobs.find(
              (row) => row.store_key === activeStore && row.job_id === "operator",
            );
            expect(JSON.parse(String(authoredAfter?.job_json))).toEqual(
              JSON.parse(String(authoredBefore?.job_json)),
            );
            const taggedAfter = afterRuntime.jobs.find(
              (row) => row.store_key === activeStore && row.job_id === "authored-lookalike",
            );
            expect(JSON.parse(String(taggedAfter?.job_json))).toEqual(
              JSON.parse(String(taggedBeforeDoctor?.job_json)),
            );
            for (const table of ["jobs", "scratch", "authority"] as const) {
              expect(afterRuntime[table].filter(inactive)).toEqual(
                beforeRuntime[table].filter(inactive),
              );
            }
            expect(getCronJobsStoreRevision(retiredStore)).toBe(retiredRevision);
            mutations.length = 0;
            await runRegisteredDreamingService(config, cron, logger);
            expect(mutations).toEqual([]);
            expect(readRows(fixture.db())).toEqual(afterRuntime);
          } finally {
            cron.stop();
          }
        },
        {
          activeDreaming,
          additionalActiveJobs: [
            makeJob("authored-lookalike", {
              description: "[managed-by=memory-core.short-term-promotion] operator note",
              schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 },
              sessionTarget: "isolated",
              payload: { kind: "agentTurn", message: "Summarize my authored project notes." },
              delivery: { mode: "none" },
            }),
          ],
        },
      );
    },
  );

  it("requires Doctor for a declared legacy payload before runtime converges the same job", async () => {
    await withCronFixture(async (fixture) => {
      const migration = getDreamingMigration(fixture);
      const declarationKey = "memory-core:memory-dreaming-promotion";
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(`UPDATE cron_jobs
          SET declaration_key = ?, job_json = json_set(job_json, '$.declarationKey', ?)
          WHERE store_key = ? AND job_id = 'survivor'`).run(
          declarationKey,
          declarationKey,
          fixture.activeStore,
        );
      });
      const { cron, logger, mutations } = createPausedCronService(fixture);
      try {
        // Admit existing schedules before isolating the dreaming reconciliation's mutations.
        await cron.list({ includeDisabled: true });
        const before = readRows(fixture.db());
        const previousRevisions = revisions(fixture);
        const original = before.jobs.find(
          (row) => row.store_key === fixture.activeStore && row.job_id === "survivor",
        );
        const config: OpenClawConfig = {
          plugins: {
            entries: {
              "memory-core": {
                config: { dreaming: { enabled: true, frequency: "15 4 * * *", timezone: "UTC" } },
              },
            },
          },
        };
        await runRegisteredDreamingService(config, cron, logger);
        expect(mutations).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
        expect(readRows(fixture.db())).toEqual(before);
        expect(revisions(fixture)).toEqual(previousRevisions);
        expect(await listBackups(fixture.databasePath)).toEqual([]);

        const repaired = await migration.migrateLegacyState(migrationInput(fixture));
        const backups = await listBackups(fixture.databasePath);
        expect(backups).toHaveLength(1);
        expect(repaired.changes.join("\n")).toContain(backups[0]);
        const migrated = readRows(fixture.db()).jobs.find(
          (row) => row.store_key === fixture.activeStore && row.job_id === "survivor",
        );
        expect(migrated).toMatchObject({
          job_id: "survivor",
          sort_order: original?.sort_order,
          state_json: original?.state_json,
          runtime_updated_at_ms: original?.runtime_updated_at_ms,
        });
        expect(JSON.parse(String(migrated?.job_json))).toMatchObject({
          declarationKey,
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", lightContext: true },
        });
        await runRegisteredDreamingService(config, cron, logger);
        expect(mutations).toEqual([{ jobId: "survivor", action: "updated" }]);
        const managed = (await cron.list({ includeDisabled: true })).filter(
          (job) => job.declarationKey === declarationKey,
        );
        expect(managed).toMatchObject([
          { id: "survivor", enabled: true, payload: { kind: "agentTurn" } },
        ]);
      } finally {
        cron.stop();
      }
    });
  });

  it("does not back up or publish unchanged definitions", async () => {
    await withCronFixture(async (fixture) => {
      const inventory = await inspectCronJobsForDoctor(fixture.scope);
      const job = findJob(inventory, fixture.activeStore, "survivor");
      const before = readRows(fixture.db());
      const previousRevisions = revisions(fixture);
      await expect(
        repairCronJobsForDoctor(fixture.scope, makeAuthority(), inventory, [
          { job, definition: structuredClone(job.definition) },
        ]),
      ).resolves.toEqual({ changed: 0 });
      expect(readRows(fixture.db())).toEqual(before);
      expect(await listBackups(fixture.databasePath)).toEqual([]);
      expect(revisions(fixture)).toEqual(previousRevisions);
    });
  });

  it.each(["after backup", "inside transaction"] as const)(
    "rejects expired repair authority %s without changing or publishing rows",
    async (phase) => {
      await withCronFixture(async (fixture) => {
        const inventory = await inspectCronJobsForDoctor(fixture.scope);
        const before = readRows(fixture.db());
        const previousRevisions = revisions(fixture);
        let active = true;
        const authority = makeAuthority();
        authority.assertCurrent = () => {
          if (!active) {
            throw new Error("Doctor repair owner expired");
          }
        };
        authority.assertOwnedInTransaction = (db) => {
          expect(db.isTransaction).toBe(true);
          if (phase === "inside transaction") {
            throw new Error("Doctor repair owner expired");
          }
        };
        afterBackup(() => {
          if (phase === "after backup") {
            active = false;
          }
        });
        await expect(
          repairCronJobsForDoctor(fixture.scope, authority, inventory, [
            changeDescription(findJob(inventory, fixture.activeStore, "survivor")),
          ]),
        ).rejects.toThrow("Doctor repair owner expired");
        expect(readRows(fixture.db())).toEqual(before);
        expect(await listBackups(fixture.databasePath)).toHaveLength(1);
        expect(revisions(fixture)).toEqual(previousRevisions);
      });
    },
  );

  it("rejects definitions changed after backup before applying any selected row", async () => {
    await withCronFixture(async (fixture) => {
      const inventory = await inspectCronJobsForDoctor(fixture.scope);
      const previousRevisions = revisions(fixture);
      let concurrentRows = readRows(fixture.db());
      afterBackup(() => {
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "UPDATE cron_jobs SET job_json = job_json || ' ' WHERE job_id = 'operator'",
          ).run();
        });
        concurrentRows = readRows(fixture.db());
      });
      await expect(
        repairCronJobsForDoctor(fixture.scope, makeAuthority(), inventory, [
          changeDescription(findJob(inventory, fixture.activeStore, "survivor")),
          { job: findJob(inventory, fixture.retiredStore, "retired"), definition: null },
        ]),
      ).rejects.toThrow("Cron definitions changed during Doctor repair");
      expect(readRows(fixture.db())).toEqual(concurrentRows);
      expect(revisions(fixture)).toEqual(previousRevisions);
    });
  });

  it("rolls back earlier changes and publication when a later retirement fails", async () => {
    await withCronFixture(async (fixture) => {
      const inventory = await inspectCronJobsForDoctor(fixture.scope);
      const before = readRows(fixture.db());
      const previousRevisions = revisions(fixture);
      const authority = makeAuthority();
      authority.assertOwnedInTransaction = (db) => {
        expect(db.isTransaction).toBe(true);
        db.exec(`CREATE TEMP TRIGGER refuse_doctor_delete BEFORE DELETE ON main.cron_jobs
          WHEN OLD.job_id = 'duplicate'
          BEGIN SELECT RAISE(ABORT, 'fixture refuses retirement'); END`);
      };
      try {
        await expect(
          repairCronJobsForDoctor(fixture.scope, authority, inventory, [
            changeDescription(findJob(inventory, fixture.activeStore, "survivor")),
            { job: findJob(inventory, fixture.activeStore, "duplicate"), definition: null },
          ]),
        ).rejects.toThrow("fixture refuses retirement");
      } finally {
        fixture.db().exec("DROP TRIGGER IF EXISTS temp.refuse_doctor_delete");
      }
      expect(readRows(fixture.db())).toEqual(before);
      expect(revisions(fixture)).toEqual(previousRevisions);
      expect(await listBackups(fixture.databasePath)).toHaveLength(1);
    });
  });
});
