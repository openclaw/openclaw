import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { setSqliteBusyTimeout } from "../src/infra/sqlite-busy-timeout.js";
import { withStateDatabaseSchemaMaintenance } from "../src/infra/state-database-maintenance.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "../src/infra/update-run-driver.js";
import { createUpdateRun, finishUpdateRun } from "../src/infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../src/infra/update-run-timeouts.js";
import { closeOpenClawStateDatabaseByPath } from "../src/state/openclaw-state-db-cache.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../src/state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../src/state/openclaw-state-db.js";
import { withEnv } from "../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const publicationGraceMs = 5 * 60_000;
const instances: OpenClawTestInstance[] = [];
const observers: DatabaseSync[] = [];
afterEach(async () => {
  for (const observer of observers.splice(0)) {
    observer.close();
  }
  for (const instance of instances.splice(0)) {
    await instance.cleanup();
  }
});
function observe(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  observers.push(db);
  return db;
}
const abandoned = { status: "failed", phase: "finished", reason: "abandoned" };
const deferredSchema = { published: 15, metadata: 15, content: OPENCLAW_STATE_SCHEMA_VERSION };

async function cliJson<T = Record<string, unknown>>(
  instance: OpenClawTestInstance,
  args: string[],
  code = 0,
): Promise<T> {
  const result = await instance.cli(args);
  expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(code);
  return JSON.parse(result.stdout);
}

function updateStatus(instance: OpenClawTestInstance) {
  return cliJson(instance, ["update", "status", "--json", "--timeout", "1"]);
}

async function expectRepair(instance: OpenClawTestInstance, runId: string) {
  expect(await cliJson(instance, ["update", "repair", "--json"])).toMatchObject({
    status: "ok",
    mode: "repair",
    restart: false,
    reconciledRuns: [runId],
  });
}

function expectStep(
  db: DatabaseSync,
  runId: string,
  step: string,
  status: string,
  detail?: string,
) {
  const row = db.prepare("SELECT steps_json FROM update_runs WHERE run_id = ?").get(runId);
  expect(JSON.parse(String(row?.steps_json))).toContainEqual(
    expect.objectContaining({ step, status, ...(detail ? { detail } : {}) }),
  );
}

async function startGateway(instance: OpenClawTestInstance) {
  await instance.startGateway();
  return expectDefined(instance.child, "Gateway fixture started without an owned process.");
}

function driverIdentity() {
  return expectDefined(readUpdateRunDriver(), "Test process identity is unavailable");
}

async function createPublicationInstance(name: string) {
  const instance = await createOpenClawTestInstance({
    name,
    config: { update: { checkOnStart: false, auto: { enabled: false } } },
    env: {
      // Exercise the production process owner and watcher, both disabled by test defaults.
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SUPERVISOR_MODE: undefined,
    },
  });
  instances.push(instance);
  return instance;
}

function seedDeferredState(instance: OpenClawTestInstance, terminal: boolean) {
  const options = { env: instance.env };
  const { db, path: databasePath } = openOpenClawStateDatabase(options);
  try {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
    const now = Date.now();
    // Migration content is already committed; the runner suite proves the v15 rebuild itself.
    db.prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
      VALUES ('state.schema.contentVersion', ?, ?)`).run(
      String(OPENCLAW_STATE_SCHEMA_VERSION),
      now,
    );
    db.prepare(`UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?,
      status = ?, phase = ?, finished_at_ms = ? WHERE run_id = ?`).run(
      now - 10 * 60_000,
      terminal ? now - 60_000 : now - publicationGraceMs,
      terminal ? "succeeded" : "running",
      terminal ? "finished" : "verifying",
      terminal ? now - 60_000 : null,
      run.runId,
    );
    db.exec(`PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
    return { databasePath, runId: run.runId };
  } finally {
    closeOpenClawStateDatabaseByPath(databasePath);
  }
}

function seedInactiveUpdateRun(
  instance: OpenClawTestInstance,
  input: { ageMs?: number; phase?: "requested" | "staging"; driver?: UpdateRunDriver } = {},
) {
  const options = { env: instance.env };
  const { db, path: databasePath } = openOpenClawStateDatabase(options);
  try {
    const run = createUpdateRun(
      {
        trigger: "cli",
        before: { version: "2026.9.2" },
        origin: input.driver ? { driver: input.driver } : {},
      },
      options,
    );
    const phase = input.phase ?? "requested";
    const lastActivity = Date.now() - (input.ageMs ?? ABANDONED_UPDATE_RUN_MS + 60_000);
    const step = { step: "requested", status: "in_progress", startedAtMs: lastActivity };
    const steps =
      phase === "requested"
        ? [step]
        : [
            { ...step, status: "completed", endedAtMs: lastActivity },
            { ...step, step: "staging" },
          ];
    db.prepare(`UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?,
      phase = ?, steps_json = ? WHERE run_id = ?`).run(
      lastActivity,
      lastActivity,
      phase,
      JSON.stringify(steps),
      run.runId,
    );
    return { databasePath, runId: run.runId, lastActivity };
  } finally {
    closeOpenClawStateDatabaseByPath(databasePath);
  }
}

function readUpdateOutcome(db: DatabaseSync, runId: string) {
  return db
    .prepare("SELECT status, phase, reason, updated_at_ms FROM update_runs WHERE run_id = ?")
    .get(runId);
}

async function expectGatewayStillServing(
  instance: OpenClawTestInstance,
  child: NonNullable<OpenClawTestInstance["child"]>,
) {
  expect(instance.child).toBe(child);
  expect(child).toMatchObject({ exitCode: null, signalCode: null });
  for (const pathname of ["/healthz", "/readyz"]) {
    const response = await fetch(`http://127.0.0.1:${instance.port}${pathname}`, {
      signal: AbortSignal.timeout(3_000),
    });
    await response.arrayBuffer();
    expect(response.status, pathname).toBe(200);
  }
}

function readSchemaVersions(db: DatabaseSync) {
  return {
    published: db.prepare("PRAGMA user_version").get()?.user_version,
    metadata: db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
      ?.schema_version,
    content: Number(
      db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
        )
        .get()?.value_json,
    ),
  };
}

function expectGatewayOwnsState(instance: OpenClawTestInstance, databasePath: string) {
  // Windows places the process-owner file under the child's isolated home directory.
  withEnv({ HOME: instance.env.HOME, USERPROFILE: instance.env.USERPROFILE }, () =>
    expect(() =>
      withStateDatabaseSchemaMaintenance({ databasePath }, () => "unexpected authority"),
    ).toThrow("another Gateway owns that state directory"),
  );
}

describe("Gateway external shared-state ownership", () => {
  it("reconciles a dead update driver at boot and repairs its ledger without restarting", async () => {
    const instance = await createPublicationInstance("gateway-abandoned-update-driver");
    const currentDriver = driverIdentity();
    const { databasePath, runId } = seedInactiveUpdateRun(instance, {
      // A live PID with a different start identity positively proves PID reuse.
      driver: {
        ...currentDriver,
        startIdentity: currentDriver.startIdentity === "0" ? "1" : "0",
      },
    });
    const database = observe(databasePath);
    const child = await startGateway(instance);
    await expect
      .poll(() => readUpdateOutcome(database, runId), { timeout: 10_000, interval: 100 })
      .toMatchObject({ status: "failed", phase: "finished", reason: "abandoned" });
    expectStep(database, runId, "reconcile:abandoned", "failed", "inactive-driver-dead");
    const status = await updateStatus(instance);
    expect(status).toMatchObject({
      lastRun: { runId, status: "failed", reason: "abandoned" },
    });
    expect(status).not.toHaveProperty("activeRun");
    await expectRepair(instance, runId);
    expectStep(database, runId, "reconcile:acknowledged", "completed");
    expect(readUpdateOutcome(database, runId)).toMatchObject(abandoned);
    await expectGatewayStillServing(instance, child);
    expectGatewayOwnsState(instance, databasePath);
  }, 120_000);

  it("preserves recent and live drivers and explicitly repairs an inactive identityless row", async () => {
    const instance = await createPublicationInstance("gateway-inactive-update-repair");
    const driver = driverIdentity();
    const inactive = seedInactiveUpdateRun(instance, { phase: "staging" });
    const live = seedInactiveUpdateRun(instance, { driver });
    const recent = seedInactiveUpdateRun(instance, { ageMs: 60_000 });
    const observer = observe(inactive.databasePath);
    const child = await startGateway(instance);
    const refused = await instance.cli(["update", "repair", "--json"]);
    expect(refused.code).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: {
        type: "cli_error",
        message: expect.stringContaining(
          `Update ${recent.runId} remains recorded as running (requested); driver PID and host not recorded, liveness: not observed;`,
        ),
      },
    });
    for (const run of [inactive, live, recent]) {
      expect(readUpdateOutcome(observer, run.runId)).toMatchObject({
        status: "running",
        reason: null,
        updated_at_ms: run.lastActivity,
      });
    }
    await expectGatewayStillServing(instance, child);

    // These synthetic drivers complete their own work before operator repair.
    for (const run of [live, recent]) {
      finishUpdateRun(
        run.runId,
        { status: "skipped", reason: "fixture-complete" },
        { env: instance.env },
      );
    }
    closeOpenClawStateDatabaseByPath(inactive.databasePath);
    await expectRepair(instance, inactive.runId);
    expect(readUpdateOutcome(observer, inactive.runId)).toMatchObject(abandoned);
    expect(await updateStatus(instance)).not.toHaveProperty("activeRun");
    await expectGatewayStillServing(instance, child);
    expectGatewayOwnsState(instance, inactive.databasePath);
  }, 120_000);

  it.each(["repair", "update"] as const)(
    "explicit %s clears legacy requested-only history without restarting",
    async (action) => {
      const instance = await createPublicationInstance(`gateway-legacy-update-${action}`);

      const inactive = seedInactiveUpdateRun(instance);
      const observer = observe(inactive.databasePath);
      const child = await startGateway(instance);
      const before = await updateStatus(instance);
      expect(before).toMatchObject({
        activeRun: { runId: inactive.runId },
        staleRun: { runId: inactive.runId },
      });
      expect(readUpdateOutcome(observer, inactive.runId)).toMatchObject({
        status: "running",
        updated_at_ms: inactive.lastActivity,
      });
      const result = await instance.cli(
        action === "repair"
          ? ["update", "repair", "--json"]
          : ["update", "--yes", "--json", "--dry-run"],
        { timeoutMs: 60_000 },
      );
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      if (action === "repair") {
        expect(JSON.parse(result.stdout)).toMatchObject({
          status: "ok",
          restart: false,
          reconciledRuns: [inactive.runId],
        });
      }
      expect(readUpdateOutcome(observer, inactive.runId)).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: action === "repair" ? "abandoned" : "superseded",
      });
      expect(await updateStatus(instance)).not.toHaveProperty("activeRun");
      await expectGatewayStillServing(instance, child);
      expectGatewayOwnsState(instance, inactive.databasePath);
    },
    120_000,
  );

  it("keeps CLI readers usable while the owning Gateway defers schema publication", async () => {
    const instance = await createPublicationInstance("gateway-deferred-schema-readers");
    const { databasePath } = seedDeferredState(instance, true);
    const observer = observe(databasePath);
    await instance.startGateway();
    expectGatewayOwnsState(instance, databasePath);
    expect(readSchemaVersions(observer)).toEqual(deferredSchema);

    for (const args of [
      ["agents", "list", "--json"],
      ["doctor", "--non-interactive", "--json"],
      ["update", "--yes", "--json", "--dry-run"],
    ]) {
      const result = await instance.cli(args, { timeoutMs: 60_000 });
      expect(result.code, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`).toBe(0);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stderr).not.toMatch(
        /schema migration pending|refused shared state schema mutation|another Gateway owns/u,
      );
      expect(readSchemaVersions(observer)).toEqual(deferredSchema);
      expectGatewayOwnsState(instance, databasePath);
    }
  }, 240_000);

  it("publishes from the owning Gateway timer after a running update finishes and goes quiet", async () => {
    const instance = await createPublicationInstance("gateway-deferred-schema-timer");
    const { databasePath, runId } = seedDeferredState(instance, false);
    const database = observe(databasePath);
    await instance.startGateway();
    expectGatewayOwnsState(instance, databasePath);
    expect(readSchemaVersions(database)).toEqual(deferredSchema);

    const publishAfterMs = Date.now() + 10_000;
    const finishedAtMs = publishAfterMs - publicationGraceMs;
    const writer = new DatabaseSync(databasePath);
    try {
      setSqliteBusyTimeout(writer, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
      // Deliver an aged terminal fixture through a separate connection, like the old CLI.
      writer
        .prepare(`UPDATE update_runs SET status = 'succeeded', phase = 'finished',
          finished_at_ms = ?, updated_at_ms = ? WHERE run_id = ?`)
        .run(finishedAtMs, finishedAtMs, runId);
    } finally {
      writer.close();
    }

    // Only bare SQLite reads follow: runner opens or CLI activity would conceal a broken timer.
    let publishedBeforeDeadline = false;
    await expect
      .poll(
        () => {
          const versions = readSchemaVersions(database);
          publishedBeforeDeadline ||=
            Date.now() < publishAfterMs && (versions.published !== 15 || versions.metadata !== 15);
          return versions;
        },
        { timeout: 20_000, interval: 100 },
      )
      .toEqual({
        published: OPENCLAW_STATE_SCHEMA_VERSION,
        metadata: OPENCLAW_STATE_SCHEMA_VERSION,
        content: OPENCLAW_STATE_SCHEMA_VERSION,
      });
    expect(publishedBeforeDeadline).toBe(false);
    expect(
      database
        .prepare("SELECT status, finished_at_ms, updated_at_ms FROM update_runs WHERE run_id = ?")
        .get(runId),
    ).toEqual({
      status: "succeeded",
      finished_at_ms: finishedAtMs,
      updated_at_ms: finishedAtMs,
    });
  }, 120_000);

  it("refuses unmarked startup and accepts the external supervisor marker", async () => {
    const instance = await createOpenClawTestInstance({
      name: "gateway-external-state-owner",
      env: { OPENCLAW_SUPERVISOR_MODE: "external" },
      startTimeoutMs: 30_000,
    });
    instances.push(instance);
    const claimed = await cliJson<{ databasePath: string }>(instance, [
      "database",
      "ownership",
      "claim",
      "--manager",
      "gateway-supervisor",
      "--json",
    ]);
    expect(claimed).toMatchObject({
      status: "external",
      ownership: { managerId: "gateway-supervisor" },
    });
    const unreadable = await cliJson(
      instance,
      ["database", "preflight", `${instance.stateDir}/missing.sqlite`, "--json"],
      1,
    );
    expect(unreadable).toMatchObject({
      schema: "openclaw.state-schema-preflight.v1",
      status: "indeterminate",
    });

    delete instance.env.OPENCLAW_SUPERVISOR_MODE;
    await expect(instance.startGateway()).rejects.toThrow(/gateway-supervisor/u);
    expect(instance.logs()).toMatch(/OPENCLAW_SUPERVISOR_MODE=external/u);

    instance.env.OPENCLAW_SUPERVISOR_MODE = "external";
    await instance.startGateway();
    expect(instance.child).toBeDefined();
  });
});
