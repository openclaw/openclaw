import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import memoryCore from "../../extensions/memory-core/index.js";
import {
  inspectCronJobsForDoctor,
  repairCronJobsForDoctor,
} from "../../src/commands/doctor/cron/store-repair.js";
import type { OpenClawConfig } from "../../src/config/types.js";
import { CronService, type CronEvent } from "../../src/cron/service.js";
import { createNoopLogger } from "../../src/cron/service.test-harness.js";
import { getCronJobsStoreRevision } from "../../src/cron/store.js";
import type { CronStoredJob } from "../../src/cron/types.js";
import type { EngineConnection } from "../../src/infra/sql-connection.js";
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
import { createTestGatewayScheduler } from "../../src/test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { seedCronStoreInCurrentDatabase } from "../helpers/cron/store.js";

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

function authoredJob(id: string, message: string, fields: Partial<CronStoredJob> = {}) {
  return makeJob(id, {
    description: `${managedTag} operator note`,
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message },
    delivery: { mode: "none" },
    ...fields,
  });
}

function readRows(db: EngineConnection) {
  const rows = (table: string) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY store_key, job_id`).all();
  return {
    jobs: rows("cron_jobs"),
    scratch: rows("cron_job_scratch"),
    authority: rows("cron_job_runtime_authorities"),
  };
}

type Rows = ReturnType<typeof readRows>;
type Row = Record<string, unknown>;
const inStore =
  (store: string, ...ids: string[]) =>
  (row: Row) =>
    row.store_key === store && (!ids.length || ids.includes(String(row.job_id)));
const tables = ["jobs", "scratch", "authority"] as const;
const declarationKey = "memory-core:memory-dreaming-promotion";
const marker = "__openclaw_memory_core_short_term_promotion_dream__";
const managedTag = "[managed-by=memory-core.short-term-promotion]";
const legacyPayloadOptions = { timeoutSeconds: 90, toolsAllow: ["read"] };
const authoredPayloadOptions = { model: "openai/gpt-4.1-mini", timeoutSeconds: 90 };
const anchoredSchedule = { kind: "every", everyMs: 60_000, anchorMs: 1_800_000_000_000 } as const;
const dreamingPayload = {
  kind: "agentTurn",
  message: marker,
  lightContext: true,
};
const migratedDefinition = {
  declarationKey,
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", lightContext: true },
  delivery: { mode: "none" },
};
const dreamingConfig = (enabled: boolean): OpenClawConfig => ({
  plugins: {
    entries: {
      "memory-core": {
        config: { dreaming: { enabled, frequency: "15 4 * * *", timezone: "UTC" } },
      },
    },
  },
});
const rowAt = (rows: Rows, store: string, id: string) => rows.jobs.find(inStore(store, id));
const definitionOf = (row: Row | undefined) => JSON.parse(String(row?.job_json));

function expectPreservedRows(before: Rows, after: Rows, keep: (row: Row) => boolean) {
  for (const table of tables) {
    expect(after[table].filter(keep)).toEqual(before[table].filter(keep));
  }
}

function expectFilteredRows(
  before: Rows,
  after: Rows,
  keep: (row: Row) => boolean,
  selected: readonly (keyof Rows)[] = tables,
) {
  for (const table of selected) {
    expect(after[table]).toEqual(before[table].filter(keep));
  }
}

function expectPreservedRuntime(row: Row | undefined, original: Row | undefined, id: string) {
  expect(row).toMatchObject({
    job_id: id,
    sort_order: original?.sort_order,
    state_json: original?.state_json,
    runtime_updated_at_ms: original?.runtime_updated_at_ms,
  });
}

async function snapshot(fixture: Fixture) {
  return {
    rows: readRows(fixture.db()),
    revisions: revisions(fixture),
    backups: await listBackups(fixture.databasePath),
  };
}

function expectBackup(backupPath: string, before: Rows) {
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    expect(readRows(backup)).toEqual(before);
  } finally {
    backup.close();
  }
}

type Fixture = {
  state: OpenClawTestState;
  scope: { config: OpenClawConfig; env: NodeJS.ProcessEnv };
  activeStore: string;
  retiredStore: string;
  untouchedStore: string;
  databasePath: string;
  db: () => EngineConnection;
};

async function withCronFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: {
    activeDreaming?: boolean;
    additionalActiveJobs?: CronStoredJob[];
    legacyFields?: (id: string) => Partial<CronStoredJob>;
  } = {},
) {
  await withOpenClawTestState({ label: "cron-doctor" }, async (state) => {
    const activeStore = state.statePath("cron", "jobs.json");
    const retiredStore = state.statePath("retired", "cron", "jobs.json");
    const untouchedStore = state.statePath("operator", "jobs.json");
    const legacyFields: Partial<CronStoredJob> = {
      name: "Memory Dreaming Promotion",
      description: `${managedTag} legacy`,
      payload: { kind: "systemEvent", text: marker },
    };
    const legacyJob = (id: string, fields: Partial<CronStoredJob> = {}) =>
      makeJob(id, { ...legacyFields, ...fields });
    for (const [storePath, jobs] of [
      [
        activeStore,
        [
          ...(options.activeDreaming === false
            ? []
            : [legacyJob("survivor"), legacyJob("duplicate", { createdAtMs: 1_800_000_000_100 })]),
          makeJob("operator", { schedule: anchoredSchedule }),
          ...(options.additionalActiveJobs ?? []),
        ],
      ],
      [retiredStore, [legacyJob("retired"), makeJob("malformed")]],
      [untouchedStore, [makeJob("survivor")]],
    ] as const) {
      seedCronStoreInCurrentDatabase(storePath, { version: 1, jobs: [...jobs] });
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      const readDefinition = db.prepare(
        "SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?",
      );
      const writeDefinition = db.prepare(
        "UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?",
      );
      // Seed normalization removes legacy-only fields, so install raw definitions afterward.
      for (const [store, id] of [
        [activeStore, "survivor"],
        [activeStore, "duplicate"],
        [retiredStore, "retired"],
      ]) {
        const fields = options.legacyFields?.(id);
        const row = readDefinition.get(store, id);
        if (!fields || !row) {
          continue;
        }
        const job = { ...definitionOf(row), ...fields };
        db.prepare(`UPDATE cron_jobs SET job_json = ?, name = ?, description = ?, payload_kind = ?
          WHERE store_key = ? AND job_id = ?`).run(
          JSON.stringify(job),
          job.name,
          job.description,
          job.payload.kind,
          store,
          id,
        );
      }
      db.prepare("UPDATE cron_jobs SET sort_order = 17 WHERE store_key = ? AND job_id = ?").run(
        activeStore,
        "survivor",
      );
      writeDefinition.run(
        ` \n${String(readDefinition.get(activeStore, "operator")?.job_json)}\n `,
        activeStore,
        "operator",
      );
      writeDefinition.run("{ malformed legacy definition", retiredStore, "malformed");
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

function getDreamingMigration({ state, scope }: Fixture) {
  const entry = listPluginDoctorStateMigrationEntries({
    ...scope,
    pluginIds: ["memory-core"],
  }).find(({ migration }) => migration.id === "memory-core-dreaming-cron");
  if (!entry) {
    throw new Error("Missing registered memory-core dreaming cron migration");
  }
  const input = {
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
  return {
    detectLegacyState: () => entry.migration.detectLegacyState(input),
    migrateLegacyState: () => entry.migration.migrateLegacyState(input),
  };
}

async function withRuntime(
  fixture: Fixture,
  run: (runtime: {
    cron: CronService;
    logger: ReturnType<typeof createNoopLogger>;
    mutations: Array<Pick<CronEvent, "jobId" | "action">>;
    reconcile: (config: OpenClawConfig) => Promise<void>;
  }) => Promise<void>,
) {
  const logger = createNoopLogger();
  const mutations: Array<Pick<CronEvent, "jobId" | "action">> = [];
  const scheduler = createTestGatewayScheduler();
  const cron = new CronService({
    scheduler,
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
  async function reconcile(config: OpenClawConfig) {
    const registry = createEmptyPluginRegistry();
    const starts: Array<{ mock: { results: Array<{ value: unknown }> } }> = [];
    const backgroundTasks: Promise<unknown>[] = [];
    const api = createTestPluginApi({
      id: "memory-core",
      config,
      logger,
      runtime: createPluginRuntimeMock({ config: { current: () => config } }),
      registerService(service) {
        // Boot-path starts log failures instead of rejecting; observe them here.
        starts.push(vi.spyOn(service, "start"));
        registry.services.push({
          pluginId: "memory-core",
          origin: "bundled",
          source: "memory-core/index.ts",
          id: service.id,
          service,
        });
      },
    });
    api.lifecycle.runInBackgroundContext = (background) => {
      const result = background();
      if (result instanceof Promise) {
        backgroundTasks.push(result);
      }
      return result;
    };
    memoryCore.register(api);
    if (!registry.services.some(({ id }) => id === "memory-core-dreaming")) {
      throw new Error("Memory Core did not register its dreaming service");
    }
    let services: PluginServicesHandle | undefined;
    try {
      // Gateway boot starts services without the hot-reload candidate deadline.
      services = await startPluginServices({
        scheduler,
        registry,
        config,
        getCronService: () => cron,
        onHandle(handle) {
          services = handle;
        },
      });
      const settled = await Promise.allSettled(
        starts.flatMap(({ mock }) => mock.results.map(({ value }) => value)),
      );
      expect(settled.filter(({ status }) => status === "rejected")).toEqual([]);
      await Promise.all(backgroundTasks);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await services?.stop({ strict: true });
    }
  }
  try {
    await run({ cron, logger, mutations, reconcile });
  } finally {
    cron.stop();
    await scheduler.stop();
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
    seedCronStoreInCurrentDatabase(fixture.untouchedStore, {
      version: 1,
      jobs: [
        makeJob("survivor"),
        authoredJob("authored-phase", "Summarize workspace activity.", {
          name: "Operator-authored workflow",
          description: `[managed-by=memory-core.dreaming.light] ${managedTag} operator note`,
        }),
        authoredJob("authored-unified", "Review the project notes.", {
          name: "Operator-authored review",
        }),
      ],
    });
    const before = readRows(fixture.db());
    const previousRevisions = revisions(fixture);
    expect(await migration.detectLegacyState()).not.toBeNull();
    expect(readRows(fixture.db())).toEqual(before);
    const runtimeJson = '{ "nextRunAtMs": 1800000999999, "lastRunStatus": "error" }';
    afterBackup(() => {
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(`UPDATE cron_jobs SET state_json = ?, runtime_updated_at_ms = 1800000000999
            WHERE store_key = ? AND job_id = 'survivor'`).run(runtimeJson, activeStore);
      });
    });
    const result = await migration.migrateLegacyState();
    expect(result.changes.length).toBeGreaterThan(0);
    const backups = await listBackups(databasePath);
    expect(backups).toHaveLength(1);
    const backupPath = backups[0]!;
    expect(result.changes.join("\n")).toContain(backupPath);
    const after = readRows(fixture.db());
    const survivor = rowAt(after, activeStore, "survivor");
    expect(survivor).toMatchObject({
      job_id: "survivor",
      sort_order: 17,
      state_json: runtimeJson,
      runtime_updated_at_ms: 1_800_000_000_999,
    });
    expect(definitionOf(survivor)).toMatchObject({
      ...migratedDefinition,
      id: "survivor",
    });
    const inactiveSurvivor = rowAt(after, retiredStore, "retired");
    expectPreservedRuntime(inactiveSurvivor, rowAt(before, retiredStore, "retired"), "retired");
    expect(inactiveSurvivor).toMatchObject({ store_key: retiredStore });
    expect(definitionOf(inactiveSurvivor)).toMatchObject(migratedDefinition);
    const unaffected = (row: Row) =>
      !inStore(activeStore, "survivor", "duplicate")(row) && !inStore(retiredStore, "retired")(row);
    expectPreservedRows(before, after, unaffected);
    const isDuplicate = inStore(activeStore, "duplicate");
    for (const table of tables) {
      expect(after[table].some(isDuplicate)).toBe(false);
    }
    expectFilteredRows(before, after, (row) => !isDuplicate(row), ["scratch"]);
    const committedRevisions = revisions(fixture);
    expect(committedRevisions.active).toBeGreaterThan(previousRevisions.active);
    expect(committedRevisions.retired).toBeGreaterThan(previousRevisions.retired);
    expect(committedRevisions.untouched).toBe(previousRevisions.untouched);

    const recoveredPath = state.path("recovered.sqlite");
    await fs.copyFile(backupPath, recoveredPath);
    expectBackup(recoveredPath, before);
    const remaining = await migration.detectLegacyState();
    expect(remaining?.preview).toHaveLength(3);
    expect(remaining?.preview).toEqual(
      expect.arrayContaining([
        expect.stringContaining("malformed"),
        expect.stringMatching(/authored-phase.*review.*manually/),
        expect.stringMatching(/authored-unified.*review.*manually/),
      ]),
    );
    expect(await migration.migrateLegacyState()).toMatchObject({
      changes: [],
      warnings: remaining?.preview,
    });
    expect(await snapshot(fixture)).toEqual({
      rows: after,
      backups,
      revisions: committedRevisions,
    });
  });
});

it.each([true, false])("persists phase-only repairs with dreaming enabled=%s", async (enabled) => {
  await withCronFixture(
    async (fixture) => {
      fixture.scope.config = {
        plugins: { entries: { "memory-core": { config: { dreaming: { enabled } } } } },
      };
      const migration = getDreamingMigration(fixture);
      const phaseRows = [
        { store: fixture.activeStore, id: "survivor" },
        { store: fixture.activeStore, id: "duplicate" },
        { store: fixture.retiredStore, id: "retired" },
      ] as const;
      await migration.migrateLegacyState();
      const after = readRows(fixture.db());
      for (const { store, id } of phaseRows) {
        const survivor = rowAt(after, store, id);
        if (enabled && id !== "duplicate") {
          const definition = definitionOf(survivor);
          expect(definition).toMatchObject({
            ...migratedDefinition,
            name: "Memory Dreaming Promotion",
            description: "[managed-by=memory-core.short-term-promotion] keep operator note",
            payload: { ...dreamingPayload, ...legacyPayloadOptions },
            delivery: { mode: "none", bestEffort: true },
          });
          expect(definition.payload).not.toHaveProperty("text");
        } else {
          for (const table of tables) {
            expect(after[table].filter(inStore(store, id))).toEqual([]);
          }
        }
      }
    },
    {
      legacyFields: (id) => {
        const phase = id === "survivor" ? "light" : "rem";
        return {
          name: phase === "light" ? "Memory Light Dreaming" : "Memory REM Dreaming",
          description: `[managed-by=memory-core.dreaming.${phase}] keep operator note`,
          payload: {
            kind: "systemEvent",
            text: `__openclaw_memory_core_${phase}_sleep__`,
            ...legacyPayloadOptions,
          },
          delivery: { mode: "none", bestEffort: true },
        };
      },
    },
  );
});

it.each([
  { layout: "inactive only", activeDreaming: false, enabled: true },
  { layout: "active and inactive", activeDreaming: true, enabled: true },
  { layout: "active and inactive", activeDreaming: true, enabled: false },
])(
  "keeps $layout history and authored lookalikes after Doctor and runtime dreaming enabled=$enabled",
  async ({ activeDreaming, enabled }) => {
    await withCronFixture(
      async (fixture) => {
        const { activeStore, retiredStore } = fixture;
        const migration = getDreamingMigration(fixture);
        const taggedBeforeDoctor = rowAt(readRows(fixture.db()), activeStore, "authored-lookalike");
        expect(taggedBeforeDoctor).toBeDefined();
        const migrated = await migration.migrateLegacyState();
        expect(migrated.changes.length).toBeGreaterThan(0);
        expect(migrated.warnings).toEqual(
          expect.arrayContaining([expect.stringMatching(/authored-lookalike.*review.*manually/)]),
        );
        const beforeRuntime = readRows(fixture.db());
        expect(beforeRuntime.jobs.filter(inStore(activeStore, "authored-lookalike"))).toEqual([
          taggedBeforeDoctor,
        ]);
        expect(
          beforeRuntime.jobs.filter(
            (row) =>
              inStore(activeStore)(row) && definitionOf(row).declarationKey === declarationKey,
          ),
        ).toHaveLength(activeDreaming ? 1 : 0);
        const migratedSurvivors = beforeRuntime.jobs.filter(
          (row) => inStore(activeStore, "survivor")(row) || inStore(retiredStore, "retired")(row),
        );
        expect(migratedSurvivors).toHaveLength(activeDreaming ? 2 : 1);
        for (const row of migratedSurvivors) {
          expect(definitionOf(row).payload).toMatchObject({
            ...dreamingPayload,
            ...authoredPayloadOptions,
          });
        }
        const retiredRevision = getCronJobsStoreRevision(retiredStore);
        const inactive = (row: Row) => !inStore(activeStore)(row);
        const authoredBefore = rowAt(beforeRuntime, activeStore, "operator");
        await withRuntime(fixture, async ({ cron, logger, mutations, reconcile }) => {
          const config = dreamingConfig(enabled);
          await reconcile(config);
          expect(mutations).toEqual(
            enabled
              ? [
                  {
                    jobId: activeDreaming ? "survivor" : expect.any(String),
                    action: activeDreaming ? "updated" : "added",
                  },
                ]
              : [{ jobId: "survivor", action: "removed" }],
          );
          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("cron jobs authored-lookalike retain historical dreaming tags"),
          );
          const jobs = await cron.list({ includeDisabled: true });
          const managed = jobs.filter((job) => job.declarationKey === declarationKey);
          expect(managed).toHaveLength(enabled ? 1 : 0);
          if (enabled) {
            expect(managed[0]).toMatchObject({
              enabled: true,
              ...migratedDefinition,
              schedule: { kind: "cron", expr: "15 4 * * *", tz: "UTC" },
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
          for (const [id, original] of [
            ["operator", authoredBefore],
            ["authored-lookalike", taggedBeforeDoctor],
          ] as const) {
            expect(definitionOf(rowAt(afterRuntime, activeStore, id))).toEqual(
              definitionOf(original),
            );
          }
          expectPreservedRows(beforeRuntime, afterRuntime, inactive);
          expect(getCronJobsStoreRevision(retiredStore)).toBe(retiredRevision);
          mutations.length = 0;
          await reconcile(config);
          expect(mutations).toEqual([]);
          expect(readRows(fixture.db())).toEqual(afterRuntime);
        });
      },
      {
        activeDreaming,
        legacyFields: (id) =>
          id === "duplicate"
            ? {}
            : {
                sessionTarget: "isolated",
                payload: { kind: "agentTurn", message: marker, ...authoredPayloadOptions },
              },
        additionalActiveJobs: [
          authoredJob("authored-lookalike", "Summarize my authored project notes.", {
            schedule: anchoredSchedule,
          }),
        ],
      },
    );
  },
);

it("requires Doctor for a declared legacy payload before runtime converges the same job", async () => {
  await withCronFixture(async (fixture) => {
    const migration = getDreamingMigration(fixture);
    runOpenClawStateWriteTransaction(({ db }) => {
      db.prepare(`UPDATE cron_jobs
          SET declaration_key = ?, job_json = json_set(job_json, '$.declarationKey', ?)
          WHERE store_key = ? AND job_id = 'survivor'`).run(
        declarationKey,
        declarationKey,
        fixture.activeStore,
      );
    });
    await withRuntime(fixture, async ({ cron, logger, mutations, reconcile }) => {
      // Admit existing schedules before isolating the dreaming reconciliation's mutations.
      await cron.list({ includeDisabled: true });
      const before = await snapshot(fixture);
      const original = rowAt(before.rows, fixture.activeStore, "survivor");
      const config = dreamingConfig(true);
      await reconcile(config);
      expect(mutations).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
      expect(before.backups).toEqual([]);
      expect(await snapshot(fixture)).toEqual(before);

      const repaired = await migration.migrateLegacyState();
      const backups = await listBackups(fixture.databasePath);
      expect(backups).toHaveLength(1);
      expect(repaired.changes.join("\n")).toContain(backups[0]);
      const migrated = rowAt(readRows(fixture.db()), fixture.activeStore, "survivor");
      expectPreservedRuntime(migrated, original, "survivor");
      expect(definitionOf(migrated)).toMatchObject({
        declarationKey,
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", lightContext: true },
      });
      await reconcile(config);
      expect(mutations).toEqual([{ jobId: "survivor", action: "updated" }]);
      const managed = (await cron.list({ includeDisabled: true })).filter(
        (job) => job.declarationKey === declarationKey,
      );
      expect(managed).toMatchObject([
        { id: "survivor", enabled: true, payload: { kind: "agentTurn" } },
      ]);
    });
  });
});

it("does not back up or publish unchanged definitions", async () => {
  await withCronFixture(async (fixture) => {
    const inventory = await inspectCronJobsForDoctor(fixture.scope);
    const job = findJob(inventory, fixture.activeStore, "survivor");
    const before = await snapshot(fixture);
    await expect(
      repairCronJobsForDoctor(fixture.scope, makeAuthority(), inventory, [
        { job, definition: structuredClone(job.definition) },
      ]),
    ).resolves.toEqual({ changed: 0 });
    expect(before.backups).toEqual([]);
    expect(await snapshot(fixture)).toEqual(before);
  });
});

it.each([
  ["after backup", "Doctor repair owner expired"],
  ["inside transaction", "Doctor repair owner expired"],
  ["concurrent definition", "Cron definitions changed during Doctor repair"],
  ["retirement", "fixture refuses retirement"],
] as const)("rejects repair at %s without partial changes or publication", async (phase, error) => {
  await withCronFixture(async (fixture) => {
    const inventory = await inspectCronJobsForDoctor(fixture.scope);
    let expectedRows = readRows(fixture.db());
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
      if (phase === "retirement") {
        db.exec(`CREATE TEMP TRIGGER refuse_doctor_delete BEFORE DELETE ON main.cron_jobs
            WHEN OLD.job_id = 'duplicate'
            BEGIN SELECT RAISE(ABORT, 'fixture refuses retirement'); END`);
      }
    };
    afterBackup(() => {
      if (phase === "after backup") {
        active = false;
      }
      if (phase === "concurrent definition") {
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "UPDATE cron_jobs SET job_json = job_json || ' ' WHERE job_id = 'operator'",
          ).run();
        });
        expectedRows = readRows(fixture.db());
      }
    });
    const retiredJob =
      phase === "retirement"
        ? findJob(inventory, fixture.activeStore, "duplicate")
        : phase === "concurrent definition"
          ? findJob(inventory, fixture.retiredStore, "retired")
          : undefined;
    try {
      await expect(
        repairCronJobsForDoctor(fixture.scope, authority, inventory, [
          changeDescription(findJob(inventory, fixture.activeStore, "survivor")),
          ...(retiredJob ? [{ job: retiredJob, definition: null }] : []),
        ]),
      ).rejects.toThrow(error);
    } finally {
      if (phase === "retirement") {
        fixture.db().exec("DROP TRIGGER IF EXISTS temp.refuse_doctor_delete");
      }
    }
    expect(readRows(fixture.db())).toEqual(expectedRows);
    expect(revisions(fixture)).toEqual(previousRevisions);
    expect(await listBackups(fixture.databasePath)).toHaveLength(1);
  });
});
