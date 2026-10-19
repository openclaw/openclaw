import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { writeLegacyStateSchemaV1 } from "../infra/state-migrations.caller-mode.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as worker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  captureConfigHealthStateStore,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import { createConfigIO } from "./io.js";
import { observeConfigSnapshot } from "./io.observe.js";
import { hashConfigRaw, normalizeConfigIoDeps } from "./io.read-helpers.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

it.each(["update", "updateAfterFileCommit"] as const)(
  "preserves typed maintenance errors through %s",
  async (operation) => {
    if (operation === "update") {
      const warm = createHealthDeps();
      patchConfigHealthEntryToStore(warm, "/warm.json", {
        lastObservedSuspiciousSignature: "warm",
      });
      expect(await captureConfigHealthStateStore(warm, "/warm.json").read()).not.toBeNull();
      await closeOpenClawStateDatabaseAsync();
    }
    const deps = createHealthDeps();
    makeNewerSchema(deps);
    let incoming: unknown;
    const execute = worker.runOpenClawStateWorkerOperation;
    const spy = vi.spyOn(worker, "runOpenClawStateWorkerOperation").mockImplementation(
      new Proxy(execute, {
        async apply(target, receiver, args) {
          try {
            return await Reflect.apply(target, receiver, args);
          } catch (error) {
            incoming = error;
            throw error;
          }
        },
      }),
    );
    try {
      const store = captureConfigHealthStateStore(deps, "/config.json");
      const previous = await store.read();
      if (operation === "updateAfterFileCommit") {
        expect(previous).toEqual({ state: {}, basis: null });
      }
      const failure = await store[operation](healthEntry, previous).catch(
        (error: unknown) => error,
      );
      expect(incoming).toBeInstanceOf(StartupMaintenanceRequiredError);
      expect(failure).toBe(incoming);
      expect(findStartupMaintenanceRequiredError(failure)).toMatchObject({
        kind: "newer-schema",
      });
      expect(deps.logger.warn).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

function createHealthDeps(warn = vi.fn()) {
  const home = tempDirs.make("openclaw-health-warning-");
  return {
    env: { HOME: home, OPENCLAW_STATE_DIR: home },
    homedir: () => home,
    logger: { warn, error: vi.fn() },
  };
}

function configFixture() {
  const deps = createHealthDeps();
  const configPath = path.join(deps.env.HOME, "openclaw.json");
  const raw = JSON.stringify({ gateway: { mode: "local" } });
  fs.writeFileSync(configPath, raw);
  const options = {
    ...deps,
    configPath,
    env: { ...deps.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  };
  return { deps, configPath, raw, options };
}

function makeNewerSchema(deps: ReturnType<typeof createHealthDeps>) {
  const databasePath = resolveOpenClawStateSqlitePath(deps.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
  database.close();
}

const healthEntry = { lastObservedSuspiciousSignature: "observed" };
const healthState = {
  entries: { "/config.json": healthEntry },
};

function patchHealth(
  deps: ReturnType<typeof createHealthDeps>,
  changes: Parameters<typeof patchConfigHealthEntryToStore>[2] = healthEntry,
) {
  patchConfigHealthEntryToStore(deps, "/config.json", changes);
}

function expectWarning(deps: ReturnType<typeof createHealthDeps>, count: number, text: string) {
  expect(deps.logger.warn).toHaveBeenCalledTimes(count);
  expect(deps.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining(text));
}

describe("config health-state warnings", () => {
  it("observes config on the worker and durably reopens without main-thread SQLite", async () => {
    const { deps, configPath, raw, options } = configFixture();
    const databasePath = resolveOpenClawStateSqlitePath(deps.env);
    const snapshot = await createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
    const observationDeps = normalizeConfigIoDeps(options);
    await closeOpenClawStateDatabaseAsync();
    const mainSql = observeMainThreadSql();
    try {
      const store = captureConfigHealthStateStore(deps, configPath);
      expect((await store.read())?.state).toEqual({});
      expect(fs.existsSync(databasePath)).toBe(false);
      await observeConfigSnapshot(observationDeps, snapshot);
      const verification = captureConfigHealthStateStore(deps, configPath);
      const observed = await verification.read();
      expect(observed.state.entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(raw));
      await closeOpenClawStateDatabaseAsync();
      const reopened = captureConfigHealthStateStore(deps, configPath);
      expect(await reopened.read()).toEqual(observed);
      mainSql.expectIdle();
    } finally {
      mainSql.restore();
    }
    expect(readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastKnownGood?.hash).toBe(
      hashConfigRaw(raw),
    );
  });

  it("keeps a valid config snapshot when health observation admission retires", async () => {
    const { deps, configPath, options } = configFixture();
    patchConfigHealthEntryToStore(deps, configPath, {
      lastObservedSuspiciousSignature: "seed",
    });
    const seeded = readConfigHealthStateFromStore(deps);
    expect(await captureConfigHealthStateStore(deps, configPath).read()).not.toBeNull();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const normalized = normalizeConfigIoDeps(options);
    const realStat = normalized.fs.promises.stat.bind(normalized.fs.promises);
    const stat = vi.spyOn(normalized.fs.promises, "stat").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === configPath) {
        entered.resolve();
        await release.promise;
      }
      return realStat(...args);
    });
    const pending = createConfigIO({ ...options, fs: normalized.fs }).readConfigFileSnapshot();
    try {
      await entered.promise;
      await closeOpenClawStateDatabaseAsync();
      release.resolve();
      expect((await pending).valid).toBe(true);
      expect(readConfigHealthStateFromStore(deps)).toEqual(seeded);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      stat.mockRestore();
    }
  });

  it("keeps an async non-file health store best-effort", async () => {
    const deps = createHealthDeps();
    const databasePath = resolveOpenClawStateSqlitePath(deps.env);
    fs.mkdirSync(databasePath, { recursive: true });
    const store = captureConfigHealthStateStore(deps, "/config.json");
    const previous = await store.read();
    expect(previous.state).toEqual({});
    await store.update(healthEntry, previous);
    await store.update(healthEntry, previous);
    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Config health-state write failed:"),
    );
    expect(fs.statSync(databasePath).isDirectory()).toBe(true);
  });

  it("deduplicates write failures across fresh sync and async config reads", async () => {
    const { deps, configPath, options } = configFixture();
    const store = captureConfigHealthStateStore(deps, configPath);
    const previous = await store.read();
    await store.update({ lastObservedSuspiciousSignature: "seed" }, previous);
    openOpenClawStateDatabase(deps).db.exec(`
      CREATE TRIGGER reject_async_health_write BEFORE INSERT ON config_health_entries
      BEGIN SELECT RAISE(ABORT, 'health write rejected'); END;
    `);

    for (let i = 0; i < 3; i++) {
      expect(createConfigIO(options).loadConfig().gateway?.mode).toBe("local");
      expect((await createConfigIO(options).readConfigFileSnapshot()).valid).toBe(true);
    }

    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("health write rejected"),
    );
  });

  it("propagates audit migration required from health writes and config snapshots", async () => {
    const deps = createHealthDeps();
    const { path: databasePath } = openOpenClawStateDatabase(deps);
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    fs.renameSync(databasePath, `${databasePath}.seed`);
    fs.copyFileSync(`${databasePath}.seed`, databasePath);
    const db = new DatabaseSync(databasePath);
    db.exec("DROP TABLE audit_events");
    db.close();
    writeLegacyStateSchemaV1(databasePath);
    const migrated = new DatabaseSync(databasePath);
    migrated.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
    migrated.close();
    let failure: unknown;
    try {
      patchHealth(deps);
    } catch (error) {
      failure = error;
    }
    expect(findStartupMaintenanceRequiredError(failure)).toMatchObject({
      kind: "audit-events-v2",
      pathname: databasePath,
    });
    const configPath = path.join(deps.env.HOME, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    await expect(createConfigIO({ ...deps, configPath }).readConfigFileSnapshot()).rejects.toThrow(
      "audit-events-v2",
    );
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("reports changed failures and re-arms only after a successful health write", () => {
    const deps = createHealthDeps();
    const { db } = openOpenClawStateDatabase(deps);
    db.exec("PRAGMA query_only = ON");
    patchHealth(deps);
    readConfigHealthStateFromStore(deps);
    patchHealth(deps, {});
    patchHealth(deps);
    expectWarning(deps, 1, "readonly database");

    db.exec(`
      PRAGMA query_only = OFF;
      CREATE TRIGGER reject_health_write BEFORE INSERT ON config_health_entries
      BEGIN SELECT RAISE(FAIL, 'health write rejected'); END;
    `);
    patchHealth(deps);
    patchHealth(deps);
    expectWarning(deps, 2, "health write rejected");

    db.exec("PRAGMA query_only = ON");
    patchHealth(deps);
    expectWarning(deps, 3, "readonly database");

    db.exec("PRAGMA query_only = OFF; DROP TRIGGER reject_health_write");
    patchHealth(deps);
    expect(readConfigHealthStateFromStore(deps)).toEqual(healthState);
    db.exec("PRAGMA query_only = ON");
    patchHealth(deps);
    patchHealth(deps);
    expectWarning(deps, 4, "readonly database");
  });

  it("does not re-arm a repeated warning when a nested successful write rolls back", () => {
    const deps = createHealthDeps();
    const { db } = openOpenClawStateDatabase(deps);
    db.exec("PRAGMA query_only = ON");
    patchHealth(deps);
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    db.exec("PRAGMA query_only = OFF");
    const abort = new Error("outer rollback");
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        patchHealth(deps);
        throw abort;
      }, deps),
    ).toThrow(abort);
    db.exec("PRAGMA query_only = ON");
    patchHealth(deps);
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    db.exec("PRAGMA query_only = OFF");
    expect(readConfigHealthStateFromStore(deps)).toEqual({ entries: {} });
  });

  it("keeps identical failures independent for different state databases", () => {
    const warn = vi.fn();
    const stores = [createHealthDeps(warn), createHealthDeps(warn)] as const;
    for (const deps of stores) {
      openOpenClawStateDatabase(deps).db.exec("PRAGMA query_only = ON");
    }
    for (let i = 0; i < 2; i++) {
      for (const deps of stores) {
        patchHealth(deps);
      }
    }
    expect(warn).toHaveBeenCalledTimes(2);
    openOpenClawStateDatabase(stores[1]).db.exec("PRAGMA query_only = OFF");
    patchHealth(stores[1]);
    patchHealth(stores[0]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
