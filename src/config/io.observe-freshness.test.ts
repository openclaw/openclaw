import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQueryTakeFirstSync,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { writeLegacyStateSchemaV1 } from "../infra/state-migrations.caller-mode.test-helpers.js";
import { migrateLegacyConfigHealth } from "../infra/state-migrations.runtime-state.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot as readDatabaseSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction as writeTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as worker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  captureConfigHealthStateStore as captureHealth,
  readConfigHealthStateFromStore as readHealth,
  patchConfigHealthEntryToStore as patchHealthEntry,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import { readConfigHealthStateInDatabase } from "./io.health-state.kernel.js";
import type { ConfigHealthState } from "./io.health-state.types.js";
import { createConfigIO } from "./io.js";
import * as observationState from "./io.observe-state.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import { observeConfigSnapshot, observeConfigSnapshotSync } from "./io.observe.js";
import { hashConfigRaw, normalizeConfigIoDeps } from "./io.read-helpers.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function createHealthFixture(home: string, warn = vi.fn(), stateSubdir = "") {
  const configPath = path.join(home, "openclaw.json");
  return {
    home,
    configPath,
    env: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, stateSubdir) },
    homedir: () => home,
    logger: { warn, error: vi.fn() },
  };
}

function writeHealthConfig(deps: ReturnType<typeof createHealthFixture>) {
  const raw = JSON.stringify({ gateway: { mode: "local" } });
  fs.writeFileSync(deps.configPath, raw);
  const options = {
    ...deps,
    env: { ...deps.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  };
  return { deps, configPath: deps.configPath, raw, options };
}

async function readHealthConfig(deps: ReturnType<typeof createHealthFixture>) {
  const fixture = writeHealthConfig(deps);
  const snapshot = await createConfigIO({ ...deps, observe: false }).readConfigFileSnapshot();
  return { ...fixture, snapshot };
}

describe("warnings", () => {
  it.each(["update", "updateAfterFileCommit"] as const)(
    "preserves typed maintenance errors through %s",
    async (operation) => {
      if (operation === "update") {
        const warm = createHealthDeps();
        patchHealthEntry(warm, "/warm.json", {
          lastObservedSuspiciousSignature: "warm",
        });
        expect(await captureHealth(warm, "/warm.json").read()).not.toBeNull();
        await closeDatabase();
      }
      const deps = createHealthDeps();
      makeNewerSchema(deps);
      try {
        const store = captureHealth(deps, "/config.json");
        const previous = await store.read();
        if (operation === "updateAfterFileCommit") {
          expect(previous).toEqual({ state: {}, basis: null });
        }
        const failure = await store[operation](healthEntry, previous).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(StartupMaintenanceRequiredError);
        expect(findStartupMaintenanceRequiredError(failure)).toMatchObject({
          kind: "newer-schema",
        });
        expect(deps.logger.warn).not.toHaveBeenCalled();
      } finally {
        await closeDatabase();
      }
    },
  );

  function createHealthDeps(warn = vi.fn()) {
    return createHealthFixture(directories.make("openclaw-health-warning-"), warn);
  }

  function configFixture() {
    return writeHealthConfig(createHealthDeps());
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
    changes: Parameters<typeof patchHealthEntry>[2] = healthEntry,
  ) {
    patchHealthEntry(deps, "/config.json", changes);
  }

  function expectWarning(deps: ReturnType<typeof createHealthDeps>, count: number, text: string) {
    expect(deps.logger.warn).toHaveBeenCalledTimes(count);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(expect.stringContaining(text));
  }

  describe("config health-state warnings", () => {
    it("observes config on the worker and durably reopens without main-thread SQLite", async () => {
      const { deps, configPath, raw, options } = configFixture();
      const databasePath = resolveOpenClawStateSqlitePath(deps.env);
      const snapshot = await createConfigIO({
        ...options,
        observe: false,
      }).readConfigFileSnapshot();
      const observationDeps = normalizeConfigIoDeps(options);
      await closeDatabase();
      const mainSql = observeMainThreadSql();
      try {
        const store = captureHealth(deps, configPath);
        expect((await store.read())?.state).toEqual({});
        expect(fs.existsSync(databasePath)).toBe(false);
        await observeConfigSnapshot(observationDeps, snapshot);
        const verification = captureHealth(deps, configPath);
        const observed = await verification.read();
        expect(observed.state.entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(raw));
        await closeDatabase();
        const reopened = captureHealth(deps, configPath);
        expect(await reopened.read()).toEqual(observed);
        mainSql.expectIdle();
      } finally {
        mainSql.restore();
      }
      expect(readHealth(deps).entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(raw));
    });

    it("keeps a valid config snapshot when health observation admission retires", async () => {
      const { deps, configPath, options } = configFixture();
      patchHealthEntry(deps, configPath, {
        lastObservedSuspiciousSignature: "seed",
      });
      const seeded = readHealth(deps);
      expect(await captureHealth(deps, configPath).read()).not.toBeNull();
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
        await closeDatabase();
        release.resolve();
        expect((await pending).valid).toBe(true);
        expect(readHealth(deps)).toEqual(seeded);
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
      const store = captureHealth(deps, "/config.json");
      const previous = await store.read();
      expect(previous.state).toEqual({});
      await expect(store.update(healthEntry, previous)).resolves.toEqual({ status: "unavailable" });
      await expect(store.update(healthEntry, previous)).resolves.toEqual({ status: "unavailable" });
      expect(deps.logger.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("Config health-state write failed:"),
      );
      expect(fs.statSync(databasePath).isDirectory()).toBe(true);
    });

    it("deduplicates write failures across fresh sync and async config reads", async () => {
      const { deps, configPath, options } = configFixture();
      const store = captureHealth(deps, configPath);
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
      await closeDatabase();
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
      await expect(
        createConfigIO({ ...deps, configPath }).readConfigFileSnapshot(),
      ).rejects.toThrow("audit-events-v2");
      expect(deps.logger.warn).not.toHaveBeenCalled();
    });

    it("reports changed failures and re-arms only after a successful health write", () => {
      const deps = createHealthDeps();
      const { db } = openOpenClawStateDatabase(deps);
      db.exec("PRAGMA query_only = ON");
      patchHealth(deps);
      readHealth(deps);
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
      expect(readHealth(deps)).toEqual(healthState);
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
        writeTransaction(() => {
          patchHealth(deps);
          throw abort;
        }, deps),
      ).toThrow(abort);
      db.exec("PRAGMA query_only = ON");
      patchHealth(deps);
      expect(deps.logger.warn).toHaveBeenCalledTimes(1);
      db.exec("PRAGMA query_only = OFF");
      expect(readHealth(deps)).toEqual({ entries: {} });
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
});

describe("observation scope", () => {
  const signaturePatch = (signature: string) => ({ lastObservedSuspiciousSignature: signature });

  function fixture() {
    const deps = createHealthFixture(directories.make("openclaw-health-scope-"));
    const { configPath } = deps;
    const setSignature = (value: string, target = configPath) =>
      patchHealthEntry(deps, target, signaturePatch(value));
    setSignature("before");
    const entry = () => readHealth(deps).entries?.[configPath];
    const signature = () => entry()?.lastObservedSuspiciousSignature;
    const capture = (target = configPath) => captureHealth(deps, target);
    const observe = async (target = configPath) => {
      const observation = capture(target);
      return { observation, before: await observation.read() };
    };
    return { deps, configPath, entry, setSignature, signature, capture, observe };
  }

  async function snapshotFixture() {
    const fixtureState = fixture();
    const { raw, snapshot } = await readHealthConfig(fixtureState.deps);
    expect(snapshot.valid).toBe(true);
    return { ...fixtureState, raw, snapshot };
  }

  it("shares boot health observations until a committed owner write changes them", async () => {
    const { configPath, capture, setSignature } = fixture();
    await closeDatabase();
    const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
    const copies = vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationAwaited");
    const observe = () => withArtifactPreservingStateReads(() => capture().read());
    const before = await observe();
    expect(before.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
    expect(copies).not.toHaveBeenCalled();
    expect(await observe()).toEqual(before);
    expect(reads).toHaveBeenCalledTimes(1);

    setSignature("sync commit");
    const after = await observe();
    expect(after.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("sync commit");
    expect(await observe()).toEqual(after);
    expect(reads).toHaveBeenCalledTimes(2);

    const owner = capture();
    await expect(
      owner.update({ lastObservedSuspiciousSignature: "worker commit" }, after),
    ).resolves.toEqual({ status: "applied" });
    expect((await observe()).state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
      "worker commit",
    );
    await expect(
      owner.update({ lastObservedSuspiciousSignature: "stale" }, before),
    ).resolves.toEqual({ status: "conflict" });
    expect((await observe()).state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
      "worker commit",
    );
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("does not classify a failed read as a conditional-write conflict", async () => {
    const { capture, signature } = fixture();
    const read = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockRejectedValueOnce(new Error("synthetic health read failure"));
    const owner = capture();
    const previous = await owner.read();
    expect(previous.basis).toBeNull();
    read.mockRestore();
    await expect(owner.update(signaturePatch("unverified"), previous)).resolves.toEqual({
      status: "unavailable",
    });
    expect(signature()).toBe("before");
  });

  it.each(["sync", "foreign"] as const)(
    "keeps pinned health isolated from a %s commit",
    async (writerKind) => {
      const { deps, configPath, capture, setSignature, signature } = fixture();
      await closeDatabase();
      using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(deps.env));
      const owner = capture();
      if (writerKind === "sync") {
        await owner.read();
      }
      const before = await readDatabaseSnapshot(
        async () => {
          if (writerKind === "sync") {
            setSignature("live commit");
          } else {
            writer
              .prepare(
                "UPDATE config_health_entries SET last_observed_suspicious_signature = ? WHERE config_path = ?",
              )
              .run("live commit", configPath);
          }
          const pinned = await owner.read();
          expect(pinned.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
            "before",
          );
          return pinned;
        },
        { env: deps.env },
      );
      await owner.update(signaturePatch("stale recovery"), before);
      expect(signature()).toBe("live commit");
      expect(
        (await owner.read()).state.entries?.[configPath]?.lastObservedSuspiciousSignature,
      ).toBe("live commit");
    },
  );

  it("publishes imported health rows to an already-read owner", async () => {
    const { deps, configPath, capture } = fixture();
    const owner = capture();
    expect((await owner.read()).state.entries?.[configPath]?.lastPromotedGood).toBeUndefined();
    const sourcePath = path.join(deps.env.HOME, "config-health.json");
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({ entries: { [configPath]: { lastPromotedGood: { hash: "imported" } } } }),
    );
    expect(
      migrateLegacyConfigHealth({
        detected: { sourcePath, hasLegacy: true },
        stateDir: deps.env.HOME,
      }).warnings,
    ).toEqual([]);
    expect((await owner.read()).state.entries?.[configPath]?.lastPromotedGood?.hash).toBe(
      "imported",
    );
  });

  it("compares every raw health field and absence before applying an observed patch", async () => {
    const { deps, configPath, observe } = fixture();
    await closeDatabase();
    using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(deps.env));
    const row = () =>
      writer.prepare("SELECT * FROM config_health_entries WHERE config_path = ?").get(configPath);
    for (const [column, value] of [
      ["last_known_good_json", '{ "hash": "foreign" }'],
      ["last_promoted_good_json", '{"hash":"promoted"}'],
      ["last_observed_suspicious_signature", null],
      ["updated_at_ms", 123],
      ["absent", null],
    ] as const) {
      if (column === "absent") {
        writer.prepare("DELETE FROM config_health_entries WHERE config_path = ?").run(configPath);
      }
      const { observation, before } = await observe();
      if (column === "absent") {
        writer
          .prepare(
            "INSERT INTO config_health_entries(config_path, last_observed_suspicious_signature, updated_at_ms) VALUES (?, ?, ?)",
          )
          .run(configPath, "concurrently created", 456);
      } else {
        writer
          .prepare(`UPDATE config_health_entries SET ${column} = ? WHERE config_path = ?`)
          .run(value, configPath);
      }
      const foreign = row();
      await observation.update(signaturePatch("stale"), before);
      expect(row()).toEqual(foreign);
    }
  });

  it.each([false, true])(
    "preserves nested health facts and original-row comparison (rollback=%s)",
    async (rollback) => {
      const { deps, configPath, observe, setSignature, signature } = fixture();
      const { observation, before } = await observe();
      expect(before.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
      const abort = new Error("fixture outer rollback");
      const mutate = () =>
        writeTransaction(
          () => {
            setSignature("after");
            expect(() => observation.assertCurrent()).not.toThrow();
            if (rollback) {
              throw abort;
            }
          },
          { env: deps.env },
        );
      if (rollback) {
        expect(mutate).toThrow(abort);
      } else {
        mutate();
      }
      expect(signature()).toBe(rollback ? "before" : "after");
      if (rollback) {
        expect(await observation.read()).toEqual(before);
      } else {
        await observation.update(signaturePatch("stale"), before);
        expect(signature()).toBe("after");
      }
    },
  );

  it("retains its captured database after an environment change", async () => {
    const { deps, configPath, capture, setSignature } = fixture();
    const planning = capture();
    expect(await planning.read()).not.toBeNull();
    deps.env.OPENCLAW_STATE_DIR = directories.make("openclaw-other-health-store-");
    setSignature("other-store");
    const retained = (await planning.read()).state.entries?.[configPath];
    expect(retained).toMatchObject(signaturePatch("before"));
  });

  it("isolates sibling health rows and async observations from sync observation", async () => {
    const { deps, snapshot, observe, setSignature } = await snapshotFixture();
    const siblingPath = path.join(deps.env.HOME, "sibling.json");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    setSignature("sibling-before", siblingPath);
    const { observation: sibling, before } = await observe(siblingPath);
    expect(before?.basis?.[siblingPath]).toBeDefined();

    now.mockReturnValue(1_700_000_000_001);
    observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
    expect(() => sibling.assertCurrent()).not.toThrow();
    expect((await sibling.read())?.basis?.[siblingPath]).toEqual(before.basis?.[siblingPath]);
    await sibling.update(signaturePatch("sibling-after"), before);
    await closeDatabase();
    expect(readHealth(deps).entries?.[siblingPath]).toMatchObject(signaturePatch("sibling-after"));
  });

  it("preserves worker-updated fields omitted by a stale sync observation", async () => {
    const { deps, configPath, raw, snapshot, entry, observe } = await snapshotFixture();
    const priorState = readHealth(deps);
    const promoted = createConfigHealthFingerprint({
      raw,
      parsed: snapshot.parsed,
      stat: fs.statSync(configPath),
    });
    const { observation, before } = await observe();
    await observation.update({ lastPromotedGood: promoted }, before);
    const committed = entry()?.lastPromotedGood;
    expect(committed).toEqual(promoted);

    const read = vi
      .spyOn(healthOwner, "readConfigHealthStateFromStore")
      .mockReturnValueOnce(priorState);
    observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
    read.mockRestore();
    await closeDatabase();
    const after = entry();
    expect(after?.lastKnownGood?.hash).toBe(promoted.hash);
    expect(after?.lastPromotedGood).toEqual(committed);
  });

  it.each(["read", "update"] as const)(
    "rejects retired database admission during health %s",
    async (operation) => {
      const { deps, observe, signature } = fixture();
      const { observation, before } = await observe();
      await closeDatabase();
      await expect(
        operation === "read"
          ? observation.read()
          : observation.update(signaturePatch("stale"), before),
      ).rejects.toThrow("read admission");
      expect(deps.logger.warn).not.toHaveBeenCalled();
      expect(signature()).toBe("before");
    },
  );

  it("keeps a confirmed health write successful when its database is then closed", async () => {
    const { deps, observe, signature } = fixture();
    const { observation, before } = await observe();
    const execute = worker.runOpenClawStateWorkerOperation;
    let applied: unknown;
    vi.spyOn(worker, "runOpenClawStateWorkerOperation").mockImplementation(
      new Proxy(execute, {
        async apply(target, receiver, args) {
          const result: unknown = await Reflect.apply(target, receiver, args);
          applied = result;
          await closeDatabase();
          return result;
        },
      }),
    );
    await expect(observation.update(signaturePatch("committed"), before)).resolves.toEqual({
      status: "applied",
    });
    expect(applied).toBe(true);
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(signature()).toBe("committed");
  });
});

describe("observation freshness", () => {
  function fixture(prefix: string, stateSubdir = "") {
    return createHealthFixture(directories.make(prefix), vi.fn(), stateSubdir);
  }

  function readHealthRow(
    db: ReturnType<typeof openOpenClawStateDatabase>["db"],
    configPath: string,
  ) {
    return executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("config_health_entries")
        .selectAll()
        .where("config_path", "=", configPath),
    );
  }

  it.each([
    { phase: "after basis read", present: true, suspicious: false },
    { phase: "before admission", present: true, suspicious: false },
    { phase: "after dispatch", present: true, suspicious: false },
    { phase: "after dispatch", present: false, suspicious: false },
    { phase: "after dispatch", present: true, suspicious: true },
    { phase: "audit dispatched", present: true, suspicious: true },
  ])(
    "preserves newer persisted health facts $phase (existing row: $present, suspicious: $suspicious)",
    async ({ phase, present, suspicious }) => {
      const context = fixture("openclaw-observation-freshness-", "state-root");
      const { home, configPath } = context;
      const siblingPath = path.join(home, "sibling.json");
      const env = {
        ...context.env,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        VITEST: "true",
      };
      const options = {
        ...context,
        env,
      };
      const raw = (port: number) =>
        JSON.stringify({
          meta: { lastTouchedVersion: "2026.9.4" },
          gateway: { mode: "local", port },
        });
      const baselineRaw = raw(18789);
      const olderRaw = suspicious ? JSON.stringify({ update: { channel: "beta" } }) : baselineRaw;
      const newerRaw = suspicious ? JSON.stringify({ update: { channel: "stable" } }) : raw(18799);
      const readSnapshot = async (bytes: string) => {
        fs.writeFileSync(configPath, bytes);
        const snapshot = await createConfigIO({
          ...options,
          observe: false,
        }).readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        return snapshot;
      };
      const newer = await readSnapshot(newerRaw);
      await readSnapshot(olderRaw);
      const oldPromotion = observationState.createConfigHealthFingerprint({
        raw: baselineRaw,
        parsed: JSON.parse(baselineRaw),
        stat: fs.statSync(configPath),
        observedAt: "2000-01-01T00:00:00.000Z",
      });
      const timestamp = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(timestamp);
      if (present) {
        patchHealthEntry(options, configPath, {
          lastPromotedGood: oldPromotion,
          ...(suspicious
            ? { lastKnownGood: oldPromotion, lastObservedSuspiciousSignature: "seed" }
            : {}),
        });
      }
      patchHealthEntry(options, siblingPath, {
        lastKnownGood: oldPromotion,
        lastPromotedGood: oldPromotion,
      });
      const baseline = readHealth(options);
      const { db } = openOpenClawStateDatabase({ env });
      const readUpdatedAt = () => readHealthRow(db, configPath)?.updated_at_ms;
      if (present) {
        expect(readUpdatedAt()).toBe(timestamp);
      }

      const entered = createDeferredCore();
      const release = createDeferredCore();
      const deps = normalizeConfigIoDeps(options);
      const observationWork = new AsyncWorkScope();
      let expected: ConfigHealthState | undefined;
      let intervened = false;
      const writeNewerObservation = () =>
        observationWork.run(() => {
          fs.writeFileSync(configPath, newerRaw);
          observeConfigSnapshotSync(deps, newer);
          expected = readConfigHealthStateInDatabase(db);
          if (suspicious) {
            expect(expected.entries?.[configPath]?.lastObservedSuspiciousSignature).toContain(
              hashConfigRaw(newerRaw),
            );
          } else {
            expect(expected.entries?.[configPath]?.lastKnownGood?.hash).toBe(
              hashConfigRaw(newerRaw),
            );
          }
          expect(readUpdatedAt()).toBe(timestamp);
          intervened = true;
        });
      if (phase === "before admission") {
        const readFingerprint = observationState.readConfigFingerprintForPath;
        vi.spyOn(observationState, "readConfigFingerprintForPath").mockImplementation(
          async (...args) => {
            const result = await readFingerprint(...args);
            if (args[1] === `${configPath}.bak`) {
              entered.resolve();
              await release.promise;
            }
            return result;
          },
        );
      } else if (phase === "after basis read") {
        const read = stateReads.executeExistingOpenClawStateRead;
        vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
          async (...args) => {
            const reply = await read(...args);
            if (!intervened && args[1].type === "config.health.read") {
              writeNewerObservation();
            }
            return reply;
          },
        );
      } else {
        const postMessage = vi.spyOn(Worker.prototype, "postMessage");
        Worker.prototype.postMessage = function (this: Worker, ...args) {
          const request: unknown = args[0];
          const command: unknown =
            isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array
              ? deserialize(request.input)
              : undefined;
          if (
            !intervened &&
            isRecord(command) &&
            isRecord(command.input) &&
            (phase === "audit dispatched"
              ? command.type === "diagnostic.register" && command.input.scope === "config-audit"
              : command.type === "config.health.patch" && command.input.configPath === configPath)
          ) {
            // Hold the ordinary SQLite writer before dispatch. The synchronous observer
            // commits after postMessage, before the worker can admit its write transaction.
            writeTransaction(
              () => {
                Reflect.apply(postMessage, this, args);
                writeNewerObservation();
              },
              { env },
            );
            return;
          }
          Reflect.apply(postMessage, this, args);
        };
      }
      const pending = createConfigIO(options).readConfigFileSnapshot();
      try {
        if (phase === "before admission") {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Observation completed before the controlled delay");
            }),
          ]);
          writeNewerObservation();
          release.resolve();
        }
        expect((await pending).valid).toBe(true);
        await observationWork.drain();
        expect(intervened).toBe(true);
        expect(expected).toBeDefined();
        expect(readHealth(options)).toEqual(expected);
        expect(expected?.entries?.[siblingPath]).toEqual(baseline.entries?.[siblingPath]);
        await closeDatabase();
        expect(readHealth(options)).toEqual(expected);
      } finally {
        release.resolve();
        try {
          await pending;
        } finally {
          await observationWork.drain();
        }
      }
    },
  );

  it.each([' { "hash" : "legacy" } ', "{invalid"])(
    "compares raw legacy health facts without tightening their decoder: %s",
    async (legacyText) => {
      const deps = fixture("openclaw-health-legacy-basis-");
      const { configPath, env } = deps;
      patchHealthEntry(deps, configPath, {
        lastObservedSuspiciousSignature: "seed",
      });
      const { db } = openOpenClawStateDatabase({ env });
      const readRow = () => readHealthRow(db, configPath);
      const writeRaw = (text: string) =>
        writeTransaction(
          ({ db: writeDb }) => {
            executeSqliteQuerySync(
              writeDb,
              getNodeSqliteKysely<DB>(writeDb)
                .updateTable("config_health_entries")
                .set({ last_known_good_json: text })
                .where("config_path", "=", configPath),
            );
          },
          { env },
        );
      writeRaw(legacyText);
      const store = captureHealth(deps, configPath);
      const initialRead = await store.read();
      await store.update({ lastObservedSuspiciousSignature: "applied" }, initialRead);
      expect(readRow()?.last_known_good_json).toBe(legacyText);
      const snapshot = await store.read();
      const currentTimestamp = readRow()?.updated_at_ms;
      writeRaw(`${legacyText} `);
      expect(readRow()?.updated_at_ms).toBe(currentTimestamp);
      await store.update({ lastObservedSuspiciousSignature: "stale" }, snapshot);
      expect(readRow()).toMatchObject({
        last_known_good_json: `${legacyText} `,
        last_observed_suspicious_signature: "applied",
        updated_at_ms: currentTimestamp,
      });
      expect((await store.read())?.state).toEqual(snapshot.state);
    },
  );
});
