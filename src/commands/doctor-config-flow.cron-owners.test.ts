import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, transformConfigFile } from "../config/config.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../cron/agent-id.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { createCronServiceWithStateForTest } from "../cron/service.test-harness.js";
import { waitForCronRunQueue } from "../cron/service/run-queue.js";
import { captureCronSchedulerWakeForTest } from "../cron/service/scheduler-actor.test-support.js";
import { saveCronJobsStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows, loadedCronStoreFromRows } from "../cron/store/row-codec.js";
import type { CronJob } from "../cron/types.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { mintCronStandingGrantLocked } from "../gateway/operator-approval-standing-grants.worker.js";
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
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { pruneAgentConfig } from "./agents.config.js";
import {
  prepareDoctorContext,
  withDoctorConfigMaintenance,
} from "./doctor-config-flow.test-support.js";
import { maybeRepairLegacyCronStore } from "./doctor/cron/index.js";

let state: OpenClawTestState;
let storePath: string;
const stops: Array<() => Promise<void>> = [];
beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "doctor-cron-owner",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  storePath = state.statePath("cron", "jobs.json");
  await state.writeConfig(sourceConfig());
});
afterEach(async () => {
  try {
    for (const stop of stops.splice(0).toReversed()) {
      await stop();
    }
  } finally {
    vi.restoreAllMocks();
    await state?.cleanup();
  }
});

function sql(parts: TemplateStringsArray, ...values: SQLInputValue[]) {
  const statement = openOpenClawStateDatabase().db.prepare(parts.join("?"));
  return {
    run: () => statement.run(...values),
    get: () => statement.get(...values),
    all: () => statement.all(...values),
  };
}

function sourceConfig(
  options: { store?: string } & Partial<Record<"inherit" | "legacy" | "markerless", boolean>> = {},
) {
  const { store, inherit, legacy, markerless } = options;
  const defaults = {
    systemAgent: { agentId: "research" },
    ...(inherit ? { authInheritance: { agentId: "research" } } : {}),
  };
  return {
    agents: legacy
      ? {
          defaults,
          list: [{ id: "ops", ...(markerless ? {} : { default: true }) }, { id: "research" }],
        }
      : { defaults, entries: { ops: { default: true }, research: {} } },
    gateway: { mode: "local" as const },
    plugins: { enabled: false },
    ...(store ? { cron: { store } } : {}),
  };
}

async function seedJobs() {
  await saveJobs(
    storePath,
    { id: "historical", enabled: false, state: { lastRunAtMs: 123, lastRunStatus: "ok" } },
    { id: "explicit", agentId: "research", enabled: false },
    { id: "session", sessionKey: "agent:research:main", enabled: false },
    { id: "sql-owner", enabled: false },
  );
  sql`UPDATE cron_jobs SET agent_id = 'research' WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'sql-owner'`.run();
  sql`UPDATE cron_jobs SET job_json = json_set(job_json, '$.authoredNote', 'keep me') WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.run();
}

const saveJobs = (store: string, ...jobs: Partial<CronJob>[]) =>
  saveCronJobsStore(store, { version: 1, jobs: jobs.map(makeCronJob) });

function rows() {
  return loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
}

const definitions = (stored: ReturnType<typeof rows>) =>
  stored.map(({ job_id, job_json, agent_id }) => ({ job_id, job_json, agent_id }));
const jobRow = (id: string) => rows().find((row) => row.job_id === id);
const storedState = async () => ({
  jobs: rows(),
  config: await fs.readFile(state.configPath, "utf8"),
  backups: await backups(),
});

function backupRows(backupPath: string, verify = false) {
  using backup = new DatabaseSync(backupPath, { readOnly: true });
  if (verify) {
    expect(backup.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }
  return loadCronRows(backup, cronStoreKey(storePath));
}

async function backups() {
  const databasePath = openOpenClawStateDatabase().path;
  return (await fs.readdir(path.dirname(databasePath)))
    .filter((name) => name.startsWith(`${path.basename(databasePath)}.doctor-cron-`))
    .map((name) => path.join(path.dirname(databasePath), name));
}

const repairLegacy = (ctx: Awaited<ReturnType<typeof prepareDoctorContext>>) =>
  withDoctorConfigMaintenance(() =>
    maybeRepairLegacyCronStore({ cfg: ctx.cfg, options: ctx.options, prompter: ctx.prompter }),
  );

async function repair() {
  return withDoctorConfigMaintenance(async () => {
    await using ctx = await prepareDoctorContext(state.configPath);
    await runInitialConfigWriteHealth(ctx);
    return ctx;
  });
}

function createCron(defaultAgentId?: string) {
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const execute = vi.fn(async () => ({ status: "ok" as const }));
  const { cron, state: cronState } = createCronServiceWithStateForTest({
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
  stops.push(async () => {
    cron.stop();
    await scheduler.stop();
  });
  return { cron, state: cronState, execute, clock };
}

function writeRoster(remove?: string, persist = false) {
  return transformConfigFile({
    transform: (current) => {
      const canonical = createCanonicalAgentConfigFixture(current).config;
      return { nextConfig: remove ? pruneAgentConfig(canonical, remove).config : canonical };
    },
    writeOptions: {
      ...(persist ? { persistCanonicalAgentRoster: true } : {}),
      ...(remove ? { allowedAgentRosterRemovals: [remove] } : {}),
    },
    afterWrite: { mode: "none", reason: "test roster write" },
  });
}

it.each(["retains", "removes"])(
  "refuses an ordinary roster write that %s the historical agent without changing its jobs",
  async (agentChange) => {
    await state.writeConfig(sourceConfig({ inherit: agentChange === "removes" }));
    await seedJobs();
    const before = await storedState();
    const write = writeRoster(agentChange === "removes" ? "ops" : undefined, true);
    await expect(write).rejects.toMatchObject({
      code: "CONFIG_WRITE_REJECTED",
      refusal: "cron-owner-safety",
    });
    await expect(write).rejects.toThrow("openclaw doctor --fix");
    expect(await storedState()).toEqual({ ...before, backups: [] });
  },
);

it.each(["update", "remove"])(
  "refuses an operator %s before changing an unresolved historical job",
  async (operation) => {
    await seedJobs();
    const { cron } = createCron();
    expect(
      (await cron.list({ includeDisabled: true })).some((job) => job.id === "historical"),
    ).toBe(true);
    const beforeRows = rows();
    const operationResult =
      operation === "update"
        ? cron.update("historical", { name: "changed" })
        : cron.remove("historical");
    await expect(operationResult).rejects.toThrow(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
    expect(rows()).toEqual(beforeRows);
    expect(await backups()).toEqual([]);
  },
);

it("preserves historical and explicit jobs when agent deletion needs Doctor", async () => {
  await saveJobs(
    storePath,
    { id: "historical", enabled: false },
    { id: "research", agentId: "research", enabled: false },
  );
  const { cron } = createCron();
  await cron.list({ includeDisabled: true });
  const before = await storedState();
  await expect(
    cron.removeAgentJobsTransactional("research", () => writeRoster("research")),
  ).rejects.toMatchObject({ code: "CONFIG_WRITE_REJECTED", refusal: "cron-owner-safety" });
  expect(await storedState()).toEqual({ ...before, backups: [] });
});

it("preserves malformed cron bytes and the historical marker when Doctor cannot verify ownership", async () => {
  await seedJobs();
  sql`UPDATE cron_jobs SET job_json = '{malformed' WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.run();
  const before = await storedState();
  await expect(repair()).rejects.toThrow("Cannot verify ownership of malformed cron job");
  expect(await storedState()).toEqual({ ...before, backups: [] });
});

it("leaves SQLite owners unchanged on ordinary cron startup", async () => {
  await seedJobs();
  sql`UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', 123), job_json = json_set(job_json, '$.notify', json('true')) WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'sql-owner'`.run();
  const beforeDefinitions = definitions(rows());
  const { cron, execute } = createCron();
  await cron.start();
  expect(definitions(rows())).toEqual(beforeDefinitions);
  const maintained = expectDefined(jobRow("sql-owner"), "SQL-owned job after maintenance");
  expect(JSON.parse(maintained.state_json).nextRunAtMs).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(await backups()).toEqual([]);
});

it("preserves a due legacy one-shot through Doctor ownership repair, then runs it once", async () => {
  const dueAt = Date.now() - 1_000;
  await saveJobs(storePath, {
    id: "pending-one-shot",
    deleteAfterRun: false,
    schedule: { kind: "at", at: new Date(dueAt).toISOString() },
    payload: { kind: "agentTurn", message: "Run after owner repair", toolsAllow: [] },
    state: { nextRunAtMs: dueAt },
  });
  const original = rows();
  expect((await readConfigFileSnapshot()).valid).toBe(false);
  expect(rows()).toEqual(original);
  const readReceipts = () =>
    sql`SELECT status FROM cron_run_receipts WHERE job_id = 'pending-one-shot' ORDER BY started_at_ms`.all();
  expect(readReceipts()).toEqual([]);
  await repair();
  expect(await backups()).toHaveLength(1);
  const { cron, execute, clock, state: cronState } = createCron("research");
  const { wake } = await captureCronSchedulerWakeForTest(() => cron.start());
  expect(execute).not.toHaveBeenCalled();
  expect(readReceipts()).toEqual([]);
  const nextWakeAtMs = expectDefined((await cron.status()).nextWakeAtMs, "catch-up wake");
  expect(nextWakeAtMs).toBeGreaterThan(clock.clock.now());
  clock.setTime(nextWakeAtMs);
  await wake(cronState);
  await waitForCronRunQueue(cronState);
  expect(execute).toHaveBeenCalledOnce();
  expect(cron.getJob("pending-one-shot")).toMatchObject({
    agentId: "ops",
    enabled: false,
    state: { lastRunStatus: "ok" },
  });
  expect(readReceipts()).toEqual([{ status: "ok" }]);
  cron.stop();
  await cron.start();
  expect(execute).toHaveBeenCalledOnce();
  expect(readReceipts()).toEqual([{ status: "ok" }]);
});

it.each([
  { name: "missing", mode: undefined, expected: "announce" },
  { name: "retired alias", mode: "deliver", expected: "announce" },
  { name: "none casing", mode: " NoNe ", expected: "none" },
  { name: "webhook casing", mode: " WeBhOoK ", expected: "webhook" },
])(
  "keeps $name delivery visible and requires Doctor before execution",
  async ({ mode, expected }) => {
    await saveJobs(storePath, {
      id: "delivery-repair",
      agentId: "ops",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      payload: { kind: "agentTurn", message: "synthetic delivery repair", toolsAllow: [] },
      delivery: { mode: "announce" },
      state: { lastRunAtMs: 123, lastRunStatus: "ok" },
    });
    const definition = JSON.parse(rows()[0]!.job_json);
    definition.delivery = {
      ...(mode === undefined ? {} : { mode }),
      to: expected === "webhook" ? "https://example.invalid/hook" : "synthetic-target",
      ...(expected === "webhook" ? {} : { channel: "telegram" }),
    };
    definition.authoredNote = "preserve this definition";
    sql`UPDATE cron_jobs SET job_json = ${JSON.stringify(definition)} WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'delivery-repair'`.run();
    const original = rows();
    const { cron, execute } = createCron();
    await cron.start();
    expect(cron.getJob("delivery-repair")?.delivery).toEqual(definition.delivery);
    await expect(cron.run("delivery-repair", "force")).rejects.toThrow(
      "delivery requires an explicit mode",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(definitions(rows())).toEqual(definitions(original));
    expect(await backups()).toEqual([]);
    cron.stop();
    await cron.waitForIdle();
    const beforeDoctor = rows();

    const ctx = await repair();
    if (mode === undefined) {
      using snapshot = vi
        .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
        .mockRejectedValueOnce(new Error("synthetic backup failure"));
      await repairLegacy(ctx);
      expect(snapshot).toHaveBeenCalledOnce();
      expect(rows()).toEqual(beforeDoctor);
      expect(await backups()).toEqual([]);
    }
    await repairLegacy(ctx);
    const repaired = rows()[0]!;
    expect(JSON.parse(repaired.job_json)).toMatchObject({
      agentId: "ops",
      authoredNote: "preserve this definition",
      delivery: { ...definition.delivery, mode: expected },
    });
    expect(repaired).toMatchObject({
      state_json: beforeDoctor[0]!.state_json,
      sort_order: original[0]!.sort_order,
    });
    const savedBackups = await backups();
    expect(savedBackups).toHaveLength(1);
    expect(backupRows(savedBackups[0]!)).toEqual(beforeDoctor);
    await repairLegacy(ctx);
    expect(rows()).toEqual([repaired]);
    await cron.start();
    expect(cron.getJob("delivery-repair")?.delivery?.mode).toBe(expected);
    expect(await cron.run("delivery-repair", "force")).toEqual({ ok: true, ran: true });
    expect(execute).toHaveBeenCalledOnce();
  },
);

it.each([
  "health write",
  "preflight custom store",
  "health write with unsupported delivery",
  "legacy list with a machine-state custom store",
  "markerless legacy list",
])("pins the original owner before the %s and preserves recovery", async (entry) => {
  const machineStore = entry === "legacy list with a machine-state custom store";
  const markerless = entry === "markerless legacy list";
  const customStore = entry === "preflight custom store" || machineStore;
  storePath = state.statePath(customStore ? "custom-cron" : "cron", "jobs.json");
  await state.writeConfig(
    sourceConfig({
      store: customStore && !machineStore ? storePath : undefined,
      legacy: machineStore || markerless,
      markerless,
    }),
  );
  if (machineStore) {
    writeConfigMachineState("cron.store", storePath);
  }
  await seedJobs();
  const oldWriterRecreation = entry === "health write";
  const retainedGrantGeneration = 40;
  if (oldWriterRecreation) {
    const db = openOpenClawStateDatabase().db;
    sql`INSERT INTO operator_approvals (
             cursor_id, approval_id, resolution_ref, kind, status, presentation_json,
             reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
             created_at_ms, expires_at_ms, updated_at_ms, decision, terminal_reason,
             resolved_at_ms, resolver_kind
           ) VALUES (1, 'historical-approval', ${"a".repeat(43)}, 'exec', 'allowed', '{}', '[]', '[]',
                     'historical-epoch', 1, 3, 2, 'allow-always', 'user', 2, 'device')`.run();
    const historical = expectDefined(
      loadedCronStoreFromRows(rows()).store.jobs.find((job) => job.id === "historical"),
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
    sql`UPDATE operator_approval_standing_grant_generations
           SET job_definition_generation = ${retainedGrantGeneration}
           WHERE grant_id = (SELECT grant_id FROM operator_approval_standing_grants
                             WHERE minted_by_approval_id = 'historical-approval')`.run();
    // A released writer recreates the row without the additive generation projections.
    const releasedColumns =
      "store_key, job_id, declaration_key, owner_agent_id, name, description, enabled, agent_id, payload_kind, job_json, state_json, runtime_updated_at_ms, schedule_identity, sort_order, updated_at";
    db.prepare(
      `CREATE TEMP TABLE old_writer_cron_row AS SELECT ${releasedColumns} FROM cron_jobs WHERE store_key = ? AND job_id = 'historical'`,
    ).run(cronStoreKey(storePath));
    sql`DELETE FROM cron_jobs WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.run();
    db.exec(
      `INSERT INTO cron_jobs (${releasedColumns}) SELECT ${releasedColumns} FROM old_writer_cron_row`,
    );
    db.exec("DROP TABLE old_writer_cron_row");
  }
  const otherStorePath = state.statePath("other-cron", "jobs.json");
  if (machineStore) {
    await saveJobs(otherStorePath, { id: "other-ownerless", enabled: false });
  }
  const readOtherRows = () =>
    sql`SELECT * FROM cron_jobs WHERE store_key = ${cronStoreKey(otherStorePath)} ORDER BY sort_order, job_id`.all();
  const otherRowsBefore = machineStore ? readOtherRows() : undefined;
  const unsupportedDelivery = entry === "health write with unsupported delivery";
  if (unsupportedDelivery) {
    sql`UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery.mode', 'not-a-route') WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.run();
  }
  const original = rows();
  const originalGrant =
    sql`SELECT grant_definition_generation FROM cron_jobs WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.get();
  const ctx = await repair();
  expect(ctx.configWriteRefusal).toBeUndefined();
  const saved = await readConfigFileSnapshot();
  expect(saved.config.agents?.ownership).toBe("explicit");
  expect(saved.config.agents?.defaults?.systemAgent?.agentId).toBe("research");
  expect(saved.sourceConfig.agents?.entries?.ops).not.toHaveProperty("default");
  const repaired = rows();
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
  const repairedGrant =
    sql`SELECT grant_definition_generation, grant_definition_revision, grant_definition_updated_at FROM cron_jobs WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.get();
  expect(repairedGrant?.grant_definition_generation).toBeGreaterThan(
    Number(originalGrant?.grant_definition_generation),
  );
  expect(repairedGrant?.grant_definition_revision).toBeNull();
  expect(repairedGrant?.grant_definition_updated_at).toBeNull();
  if (oldWriterRecreation) {
    expect(originalGrant?.grant_definition_generation).toBeNull();
    expect(repairedGrant?.grant_definition_generation).toBe(retainedGrantGeneration + 1);
    expect(
      sql`SELECT grants.revoked_at_ms, generations.job_definition_generation
               FROM operator_approval_standing_grants AS grants
               JOIN operator_approval_standing_grant_generations AS generations USING (grant_id)
               WHERE grants.minted_by_approval_id = 'historical-approval'`.get(),
    ).toEqual({ revoked_at_ms: null, job_definition_generation: retainedGrantGeneration });
  }
  for (const id of ["explicit", "session", "sql-owner"]) {
    const row = repaired.find((candidate) => candidate.job_id === id);
    const before = original.find((candidate) => candidate.job_id === id);
    if (!customStore && id !== "sql-owner") {
      expect(row).toEqual(before);
    } else {
      expect(row).toMatchObject({ state_json: before?.state_json, agent_id: before?.agent_id });
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
  expect(backupRows(savedBackups[0]!, true)).toEqual(original);
  const repairedDefinitions = rows();
  await repair();
  expect(rows()).toEqual(repairedDefinitions);
  expect(await backups()).toEqual(savedBackups);
  if (machineStore) {
    expect(readOtherRows()).toEqual(otherRowsBefore);
  }
});

it("retains the marker and a verified backup when SQL ownership changes after inspection", async () => {
  await seedJobs();
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
  using _ = vi
    .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
    .mockImplementationOnce(async (params) => {
      const result = await createSnapshot(params);
      sql`UPDATE cron_jobs SET agent_id = 'research' WHERE store_key = ${cronStoreKey(storePath)} AND job_id = 'historical'`.run();
      return result;
    });
  await expect(repair()).rejects.toThrow("Cron ownership changed during Doctor repair");
  expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
  const historical = jobRow("historical");
  expect(historical?.agent_id).toBe("research");
  expect(JSON.parse(historical?.job_json ?? "null")).not.toHaveProperty("agentId");
  expect(await backups()).toHaveLength(1);
});
