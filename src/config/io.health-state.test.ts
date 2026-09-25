import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isStateDatabaseReadAdmissionInvalidatedError as retainedReadAdmissionInvalidated } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
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

it("preserves typed maintenance errors for a reloaded caller after broker reuse", async () => {
  const warm = createHealthDeps();
  patchConfigHealthEntryToStore(warm, "/warm.json", { lastObservedSuspiciousSignature: "warm" });
  {
    using first = captureConfigHealthStateStore(warm, "/warm.json");
    expect(await first.read()).not.toBeNull();
  }
  await closeOpenClawStateDatabaseAsync();
  vi.resetModules();
  const [health, errors, worker] = await Promise.all([
    import("./io.health-state.js"),
    import("../infra/startup-maintenance-required.js"),
    import("../state/openclaw-state-worker-store.js"),
  ]);
  const deps = createHealthDeps();
  const databasePath = resolveOpenClawStateSqlitePath(deps.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
  database.close();
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
    using store = health.captureConfigHealthStateStore(deps, "/config.json");
    const previous = await store.read();
    if (!previous) {
      throw new Error("Expected current observation");
    }
    let failure: unknown;
    try {
      await store.update({ lastObservedSuspiciousSignature: "observed" }, previous);
    } catch (error) {
      failure = error;
    }
    expect(incoming).toBeInstanceOf(errors.StartupMaintenanceRequiredError);
    expect(errors.findStartupMaintenanceRequiredError(failure)).toMatchObject({
      kind: "newer-schema",
    });
    expect(deps.logger.warn).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    await closeOpenClawStateDatabaseAsync();
  }
});

function createHealthDeps(warn = vi.fn()) {
  const home = tempDirs.make("openclaw-health-warning-");
  return {
    env: { HOME: home, OPENCLAW_STATE_DIR: home },
    homedir: () => home,
    logger: { warn, error: vi.fn() },
  };
}

const healthState = {
  entries: { "/config.json": { lastObservedSuspiciousSignature: "observed" } },
};

describe("config health-state warnings", () => {
  it("reads an absent health store without creating shared state", () => {
    const deps = createHealthDeps();
    const databasePath = resolveOpenClawStateSqlitePath(deps.env);

    const state = readConfigHealthStateFromStore(deps);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(state).toEqual({});
  });

  it("observes config on the worker and durably reopens without main-thread SQLite", async () => {
    const deps = createHealthDeps();
    const databasePath = resolveOpenClawStateSqlitePath(deps.env);
    const configPath = path.join(deps.env.HOME, "openclaw.json");
    const raw = JSON.stringify({ gateway: { mode: "local" } });
    fs.writeFileSync(configPath, raw);
    const options = {
      ...deps,
      configPath,
      env: { ...deps.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    };
    const snapshot = await createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
    const observationDeps = normalizeConfigIoDeps(options);
    await closeOpenClawStateDatabaseAsync();
    const mainSql = observeMainThreadSql();
    try {
      using store = captureConfigHealthStateStore(deps, configPath);
      expect((await store.read())?.state).toEqual({});
      expect(fs.existsSync(databasePath)).toBe(false);
      await observeConfigSnapshot(observationDeps, snapshot);
      using verification = captureConfigHealthStateStore(deps, configPath);
      const observed = await verification.read();
      if (!observed) {
        throw new Error("Fixture health read was superseded");
      }
      expect(observed.state.entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(raw));
      await closeOpenClawStateDatabaseAsync();
      using reopened = captureConfigHealthStateStore(deps, configPath);
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
    const deps = createHealthDeps();
    const configPath = path.join(deps.env.HOME, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    patchConfigHealthEntryToStore(deps, configPath, {
      lastObservedSuspiciousSignature: "seed",
    });
    const seeded = readConfigHealthStateFromStore(deps);
    {
      using retained = captureConfigHealthStateStore(deps, configPath);
      expect(await retained.read()).not.toBeNull();
    }
    vi.resetModules();
    const [freshConfig, freshHealth, freshLifecycle, freshReadHelpers] = await Promise.all([
      import("./io.js"),
      import("./io.health-state.js"),
      import("../state/openclaw-state-db-async-lifecycle.js"),
      import("./io.read-helpers.js"),
    ]);
    expect(freshLifecycle.isStateDatabaseReadAdmissionInvalidatedError).not.toBe(
      retainedReadAdmissionInvalidated,
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const options = {
      ...deps,
      configPath,
      env: { ...deps.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    };
    const normalized = freshReadHelpers.normalizeConfigIoDeps(options);
    const realStat = normalized.fs.promises.stat.bind(normalized.fs.promises);
    const stat = vi.spyOn(normalized.fs.promises, "stat").mockImplementation(async (...args) => {
      if (path.resolve(String(args[0])) === configPath) {
        entered.resolve();
        await release.promise;
      }
      return realStat(...args);
    });
    const pending = freshConfig
      .createConfigIO({ ...options, fs: normalized.fs })
      .readConfigFileSnapshot();
    try {
      await entered.promise;
      await closeOpenClawStateDatabaseAsync();
      release.resolve();
      expect((await pending).valid).toBe(true);
      expect(freshHealth.readConfigHealthStateFromStore(deps)).toEqual(seeded);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      stat.mockRestore();
    }
  });

  it.each(["sync", "async"] as const)(
    "%s health access keeps a non-file store best-effort",
    async (mode) => {
      const deps = createHealthDeps();
      const databasePath = resolveOpenClawStateSqlitePath(deps.env);
      fs.mkdirSync(databasePath, { recursive: true });
      if (mode === "sync") {
        expect(readConfigHealthStateFromStore(deps)).toEqual({});
        patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
        patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
      } else {
        using store = captureConfigHealthStateStore(deps, "/config.json");
        const previous = await store.read();
        if (!previous) {
          throw new Error("Fixture health read was superseded");
        }
        expect(previous.state).toEqual({});
        await store.update({ lastObservedSuspiciousSignature: "observed" }, previous);
        await store.update({ lastObservedSuspiciousSignature: "observed" }, previous);
      }
      expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Config health-state write failed:"),
      );
      expect(fs.statSync(databasePath).isDirectory()).toBe(true);
    },
  );

  it.each(["update", "updateAfterFileCommit"] as const)(
    "%s preserves maintenance failures across the worker health boundary",
    async (operation) => {
      const deps = createHealthDeps();
      const databasePath = resolveOpenClawStateSqlitePath(deps.env);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      database.close();
      using store = captureConfigHealthStateStore(deps, "/config.json");
      const previous = await store.read();
      if (!previous) {
        throw new Error("Fixture health read was superseded");
      }
      expect(previous).toEqual({ state: {}, basis: null });
      let failure: unknown;
      try {
        await store[operation]({ lastObservedSuspiciousSignature: "observed" }, previous);
      } catch (error) {
        failure = error;
      }
      expect(findStartupMaintenanceRequiredError(failure)).toMatchObject({ kind: "newer-schema" });
      expect(deps.logger.warn).not.toHaveBeenCalled();
    },
  );

  it("deduplicates write failures across fresh sync and async config reads", async () => {
    const deps = createHealthDeps();
    const configPath = path.join(deps.env.HOME, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
    using store = captureConfigHealthStateStore(deps, configPath);
    const previous = await store.read();
    if (!previous) {
      throw new Error("Fixture health read was superseded");
    }
    await store.update(
      {
        lastObservedSuspiciousSignature: "seed",
      },
      previous,
    );
    openOpenClawStateDatabase(deps).db.exec(`
      CREATE TRIGGER reject_async_health_write BEFORE INSERT ON config_health_entries
      BEGIN SELECT RAISE(ABORT, 'health write rejected'); END;
    `);

    for (let i = 0; i < 3; i++) {
      const options = {
        ...deps,
        configPath,
        env: { ...deps.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      };
      expect(createConfigIO(options).loadConfig().gateway?.mode).toBe("local");
      expect((await createConfigIO(options).readConfigFileSnapshot()).valid).toBe(true);
    }

    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("health write rejected"),
    );
  });

  it("propagates a newer database schema from health writes", () => {
    const deps = createHealthDeps();
    const databasePath = resolveOpenClawStateSqlitePath(deps.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    db.close();

    for (let i = 0; i < 3; i++) {
      expect(readConfigHealthStateFromStore(deps)).toEqual({});
      expect(() =>
        patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]),
      ).toThrow(`uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    }
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("propagates audit migration required from health writes and config snapshots", async () => {
    const deps = createHealthDeps();
    const { path: databasePath } = openOpenClawStateDatabase(deps);
    closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(databasePath);
    db.exec(`
      DROP TABLE audit_events;
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL UNIQUE,
        source_sequence INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        session_id TEXT,
        run_id TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT
      );
    `);
    db.close();
    let failure: unknown;
    try {
      patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
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
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    readConfigHealthStateFromStore(deps);
    patchConfigHealthEntryToStore(deps, "/config.json", {});
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("readonly database"),
    );

    db.exec(`
      PRAGMA query_only = OFF;
      CREATE TRIGGER reject_health_write BEFORE INSERT ON config_health_entries
      BEGIN SELECT RAISE(FAIL, 'health write rejected'); END;
    `);
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    expect(deps.logger.warn).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(
      expect.stringContaining("health write rejected"),
    );

    db.exec("PRAGMA query_only = ON");
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    expect(deps.logger.warn).toHaveBeenCalledTimes(3);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining("readonly database"));

    db.exec("PRAGMA query_only = OFF; DROP TRIGGER reject_health_write");
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    expect(readConfigHealthStateFromStore(deps)).toEqual(healthState);
    db.exec("PRAGMA query_only = ON");
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
    expect(deps.logger.warn).toHaveBeenCalledTimes(4);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining("readonly database"));
  });

  it("keeps identical failures independent for different state databases", () => {
    const warn = vi.fn();
    const stores = [createHealthDeps(warn), createHealthDeps(warn)] as const;
    for (const deps of stores) {
      openOpenClawStateDatabase(deps).db.exec("PRAGMA query_only = ON");
    }
    for (let i = 0; i < 2; i++) {
      for (const deps of stores) {
        patchConfigHealthEntryToStore(deps, "/config.json", healthState.entries["/config.json"]);
      }
    }
    expect(warn).toHaveBeenCalledTimes(2);
    openOpenClawStateDatabase(stores[1]).db.exec("PRAGMA query_only = OFF");
    patchConfigHealthEntryToStore(stores[1], "/config.json", healthState.entries["/config.json"]);
    patchConfigHealthEntryToStore(stores[0], "/config.json", healthState.entries["/config.json"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
