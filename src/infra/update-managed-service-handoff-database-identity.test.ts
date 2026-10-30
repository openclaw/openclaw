import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as fileLocks from "./file-lock-sync.js";
import * as rollback from "./sqlite-rollback-recovery.js";
import { recoverManagedUpdateLeaseJournal } from "./update-managed-service-handoff-database-recovery.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  prepareManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  prepareManagedHandoffLeaseStore,
} from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const isWindows = process.platform === "win32";
let root: string, directory: string, databasePath: string, retained: string;
beforeEach(() => {
  root = fs.realpathSync(dirs.make("handoff-identity-"));
  directory = path.join(root, "private");
  databasePath = path.join(directory, "handoffs.sqlite");
  retained = path.join(root, "retained");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixture() {
  // Opening SQLite retains an identity descriptor that prevents Windows parent renames.
  // These diagnostics need only a private file identity, not an admitted connection.
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(databasePath, "original", { mode: 0o600 });
  return captureManagedUpdateLeaseDatabaseIdentity(databasePath);
}

function aliasedPath() {
  const alias = path.join(root, "alias");
  fs.symlinkSync(root, alias, isWindows ? "junction" : "dir");
  return path.join(alias, "private", "handoffs.sqlite");
}

it.each(["file", "parent directory", "path", "missing file", "missing parent"] as const)(
  "explains a changed %s without accepting or repairing it",
  (change) => {
    vi.stubEnv("OPENCLAW_PROFILE", "diagnostic-test");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    const binding = fixture();
    const original = fs.readFileSync(databasePath);
    let detail: string;
    let currentPath = databasePath;
    fs.renameSync(change.includes("parent") ? directory : databasePath, retained);
    if (change === "file") {
      fs.writeFileSync(databasePath, original, { mode: 0o600 });
      const current = fs.lstatSync(databasePath, { bigint: true });
      detail = `file identity (recorded ${binding.databaseIdentity}; current ${current.dev}:${current.ino})`;
    } else if (change === "parent directory") {
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.renameSync(path.join(retained, path.basename(databasePath)), databasePath);
      const current = fs.lstatSync(directory, { bigint: true });
      detail = `parent directory identity (recorded ${binding.parentIdentity}; current ${current.dev}:${current.ino})`;
    } else if (change === "path") {
      currentPath = retained;
      detail = `path (recorded ${binding.databasePath}; current ${retained})`;
    } else {
      detail = `file identity (recorded ${binding.databaseIdentity}; current missing)`;
    }
    const assertion = () =>
      change === "path"
        ? captureManagedUpdateLeaseDatabaseIdentity(currentPath, binding)
        : assertManagedUpdateLeaseDatabaseIdentity(binding);
    expect(assertion).toThrow(`managed handoff lease database identity changed at ${currentPath}`);
    expect(assertion).toThrow(detail);
    expect(assertion).toThrow("Run openclaw --profile diagnostic-test update repair");
    if (change.startsWith("missing")) {
      expect(assertion).toThrow(expect.objectContaining({ code: "ENOENT" }));
      expect(fs.existsSync(databasePath)).toBe(false);
    } else {
      expect(fs.readFileSync(currentPath)).toEqual(original);
    }
  },
);

it.each([prepareManagedHandoffLeaseDatabase, createManagedHandoffLeaseDatabase])(
  "rejects a different path at %s admission",
  async (admit) => {
    const binding = fixture();
    const current = path.join(root, "other.sqlite");
    const expected = `path (recorded ${binding.databasePath}; current ${current})`;
    await expect(async () => admit(current, binding)).rejects.toThrow(expected);
    expect(fs.existsSync(current)).toBe(false);
  },
);

it.each([false, true])(
  "preserves original admission through an aliased prepared parent (ordinary path retains alias: %s)",
  async (retainsOrdinaryAlias) => {
    fs.mkdirSync(directory, { mode: 0o700 });
    const alias = aliasedPath();
    const canonicalDatabasePath = path.join(
      fs.realpathSync.native(directory),
      path.basename(databasePath),
    );
    if (retainsOrdinaryAlias) {
      const ordinaryRealpath = fs.realpathSync;
      // Windows S4U can retain a short TEMP spelling while native Root expands it.
      vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
        const resolved = ordinaryRealpath(...args);
        return args[0] === alias && typeof resolved === "string" ? alias : resolved;
      });
      fs.realpathSync.native = ordinaryRealpath.native;
    }
    const acquireLock = fileLocks.acquireFileLockSyncWithRetry;
    // Keep genuine self-contention deterministic without waiting for the retry budget.
    vi.spyOn(fileLocks, "acquireFileLockSyncWithRetry").mockImplementation((file, options) =>
      acquireLock(file, { ...options, timeoutMs: 0 }),
    );
    const store = await prepareManagedHandoffLeaseStore({
      databasePath: alias,
      serviceManagerEnv: process.env,
      originalUpdateKey: root,
    });
    const acquired = store.acquire(root, "original-owner", { kind: "update" });
    if (acquired.kind !== "acquired" || !acquired.originalDatabaseIdentity) {
      throw new Error("Original owner was not admitted");
    }
    expect(acquired.originalDatabaseIdentity.databasePath).toBe(canonicalDatabasePath);
    const pinned = await prepareManagedHandoffLeaseStore({
      databasePath: canonicalDatabasePath,
      existingIdentity: acquired.originalDatabaseIdentity,
      serviceManagerEnv: process.env,
    });
    expect(pinned.cancelUpdate(structuredClone(acquired.lease))).toBeNull();
    expect(pinned.cancelUpdate(acquired.lease)?.release()).toBe(true);
    expect(pinned.read(root)).toEqual({ kind: "absent" });
    const next = pinned.acquire(root, "next-owner", { kind: "update" });
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") {
      expect(pinned.release(next.lease)).toBe(true);
    }
    expect(fs.existsSync(databasePath + ".lock")).toBe(false);
  },
);

it("keeps nested prepared writers for different databases independently scoped", async () => {
  const paths = ["first", "second"].map((name) => path.join(root, name, "handoffs.sqlite"));
  const first = await prepareManagedHandoffLeaseDatabase(paths[0]!);
  const second = await prepareManagedHandoffLeaseDatabase(paths[1]!);
  first(true, (firstDb) => {
    expect(firstDb.location()).toBe(paths[0]);
    second(true, (secondDb) => {
      expect(secondDb.location()).toBe(paths[1]);
      expect(paths.map((file) => fs.existsSync(file + ".lock"))).toEqual([true, true]);
    });
    expect(paths.map((file) => fs.existsSync(file + ".lock"))).toEqual([true, false]);
  });
  expect(paths.map((file) => fs.existsSync(file + ".lock"))).toEqual([false, false]);
});

it("preserves a bound ordinary-path receipt when native resolution expands its parent", async () => {
  const initial = await prepareManagedHandoffLeaseDatabase(databasePath);
  initial(true, () => undefined);
  const alias = aliasedPath();
  const ordinaryRealpath = fs.realpathSync;
  // Windows ordinary realpath can retain an 8.3 spelling. Keep the genuine
  // native resolver and Root; only model that already-recorded path spelling.
  vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
    const resolved = ordinaryRealpath(...args);
    return args[0] === alias && typeof resolved === "string" ? alias : resolved;
  });
  fs.realpathSync.native = ordinaryRealpath.native;
  const identity = captureManagedUpdateLeaseDatabaseIdentity(alias);
  expect(identity.databasePath).toBe(alias);
  const pinned = await prepareManagedHandoffLeaseDatabase(alias, identity);
  const canonical = await prepareManagedHandoffLeaseDatabase(databasePath);
  // A pinned alias must inherit this call chain's writer as well as original acquisition.
  canonical(true, () => pinned(true, () => undefined));
  expect(captureManagedUpdateLeaseDatabaseIdentity(alias)).toEqual(identity);
  expect(fs.existsSync(databasePath + ".lock")).toBe(false);
});

it.skipIf(isWindows)("refuses a replaced prepared parent before creating storage", async () => {
  const prepared = await prepareManagedHandoffLeaseDatabase(databasePath);
  fs.renameSync(directory, retained);
  fs.mkdirSync(directory, { mode: 0o700 });
  expect(() => prepared(true, () => undefined)).toThrow();
  expect([fs.readdirSync(directory), fs.readdirSync(retained)]).toEqual([[], []]);
});

it.skipIf(isWindows)("quarantines an unsafe leaf without adopting its symlink target", async () => {
  const target = path.join(root, "retained.sqlite");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(target, "retained external data", { mode: 0o600 });
  fs.symlinkSync(target, databasePath);
  const prepared = await prepareManagedHandoffLeaseDatabase(databasePath);
  prepared(true, () => undefined);
  expect(fs.readFileSync(target, "utf8")).toBe("retained external data");
  expect(fs.lstatSync(databasePath).isFile()).toBe(true);
  const quarantined = fs.readdirSync(directory).filter((name) => name.includes(".unsafe-file."));
  expect(quarantined).toHaveLength(1);
  expect(fs.readlinkSync(path.join(directory, quarantined[0]!))).toBe(target);
  expect(fs.existsSync(databasePath + ".lock")).toBe(false);
});

describe("older writer contention", () => {
  beforeEach(() => {
    createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  });

  function captureError(operation: () => unknown): Error {
    try {
      operation();
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      return error;
    }
    throw new Error("Expected the SQLite operation to fail");
  }
  it.each(["existing identity", "original acquisition"] as const)(
    "reports older-writer contention for %s",
    async (kind) => {
      const options = {
        databasePath,
        serviceManagerEnv: {},
        ...(kind === "existing identity"
          ? { existingIdentity: captureManagedUpdateLeaseDatabaseIdentity(databasePath) }
          : { originalUpdateKey: root }),
      };
      const store = await prepareManagedHandoffLeaseStore(options);
      // Published writers hold SQLite directly and never participate in the new file mutex.
      using holder = new DatabaseSync(databasePath);
      holder.exec("BEGIN IMMEDIATE");
      const failure = captureError(() => store.acquire(root, "candidate", { kind: "update" }));
      expect(failure.message).toMatch(/managed handoff database is locked/i);
      expect(failure.message).toMatch(/another OpenClaw update or Doctor from an older release/i);
      expect(failure.message).toMatch(/wait for it to finish, then rerun this command/i);
      expect(failure.cause).toMatchObject({ message: "database is locked", errcode: 5 });
      expect(store.read(root)).toEqual({ kind: "absent" });

      const legacy = createManagedHandoffLeaseStore(options, { warn: vi.fn() });
      const legacyFailure = captureError(() => legacy.acquire(root, "legacy", { kind: "update" }));
      expect([legacyFailure.message, legacyFailure.cause]).toEqual([
        "database is locked",
        undefined,
      ]);

      holder.exec("COMMIT");
      expect(store.acquire(root, "candidate", { kind: "update" }).kind).toBe("acquired");
      expect(holder.prepare("SELECT owner FROM managed_update_handoffs").all()).toEqual([
        { owner: "candidate" },
      ]);
    },
  );

  it.each(["callback", "commit"] as const)("preserves native %s lock errors", async (phase) => {
    const owner = await prepareManagedHandoffLeaseDatabase(databasePath);
    let original: Error | undefined;
    if (phase === "callback") {
      using holder = new DatabaseSync(databasePath);
      using contender = new DatabaseSync(databasePath);
      holder.exec("BEGIN IMMEDIATE");
      original = captureError(() => contender.exec("BEGIN IMMEDIATE"));
      holder.exec("ROLLBACK");
    }
    using reader =
      phase === "commit" ? new DatabaseSync(databasePath, { readOnly: true }) : undefined;
    if (reader) {
      reader.exec("BEGIN");
      reader.prepare("SELECT owner FROM managed_update_handoffs").all();
    }
    const write = (db: DatabaseSync) => {
      if (original) {
        throw original;
      }
      db.exec("PRAGMA busy_timeout=0");
      const insert = db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, '{}', 1, NULL)");
      insert.run(root, "rolled-back");
    };
    const failure = captureError(() =>
      owner(true, (db) => owner.transact(db, () => write(db), {})),
    );
    expect([failure.message, failure.cause]).toEqual(["database is locked", undefined]);
    if (phase === "callback") {
      expect(failure).toBe(original);
    } else {
      reader?.exec("ROLLBACK");
      expect(reader?.prepare("SELECT owner FROM managed_update_handoffs").all()).toEqual([]);
    }
  });
});

describe("cold journal recovery", () => {
  let installKey: string;
  let existingIdentity: ReturnType<typeof captureManagedUpdateLeaseDatabaseIdentity>;
  const dead = { pid: 2_147_483_647, startIdentity: "123" };
  const original = () => ({
    version: 2,
    helper: dead,
    executor: dead,
    action: { kind: "update", mutationProtocol: "original-cancellation-v1" },
  });
  const recover = () =>
    recoverManagedUpdateLeaseJournal({ existingIdentity, installKey, serviceManagerEnv: {} });
  const store = () =>
    createManagedHandoffLeaseStore({
      databasePath,
      existingIdentity,
      originalUpdateKey: installKey,
      serviceManagerEnv: {},
    });
  const row = () => {
    using db = new DatabaseSync(databasePath, { readOnly: true });
    return db.prepare("SELECT * FROM managed_update_handoffs").all();
  };
  function seed(payload: unknown = original(), key = installKey, recovery: string | null = null) {
    using db = new DatabaseSync(databasePath);
    const insert = db.prepare("INSERT INTO managed_update_handoffs VALUES (?, ?, ?, 1, ?)");
    insert.run(key, "committed-owner", JSON.stringify(payload), recovery);
  }
  const crash = () =>
    createHotSqliteRollbackJournal({
      path: databasePath,
      mutationSql: "UPDATE managed_update_handoffs SET owner='uncommitted-owner'",
    });
  const bytes = () =>
    [databasePath, `${databasePath}-journal`].map((file) => fs.readFileSync(file));

  beforeEach(() => {
    installKey = path.join(root, "installation");
    fs.mkdirSync(installKey);
    createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
    existingIdentity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  });

  it("repairs a real cold rollback journal without deleting its committed owner, then ordinary acquisition reclaims it", async () => {
    seed();
    const committed = row();
    crash();
    expect(store().read(installKey)).toMatchObject({ kind: "unreadable", error: { errcode: 776 } });
    await recover();
    expect(row()).toEqual(committed);
    expect(fs.existsSync(`${databasePath}-journal`)).toBe(false);
    expect(captureManagedUpdateLeaseDatabaseIdentity(databasePath)).toEqual(existingIdentity);
    const next = store().acquire(installKey, "next-owner", { kind: "update" });
    expect(next.kind === "acquired" && store().release(next.lease)).toBe(true);
  });

  it("admits an empty committed executor store after its interrupted transaction", async () => {
    crash();
    await recover();
    expect(row()).toEqual([]);
  });

  it.each(["live", "unknown"])(
    "preserves the hot source bytes when the original executor is %s",
    async (state) => {
      const actor =
        state === "live"
          ? { pid: process.pid, startIdentity: String(getFileLockProcessStartTime(process.pid)) }
          : dead;
      seed({ ...original(), helper: actor, executor: actor });
      crash();
      const before = bytes();
      if (state === "unknown") {
        const kill = process.kill.bind(process);
        vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
          if (pid === dead.pid) {
            throw Object.assign(new Error("process access denied"), { code: "EPERM" });
          }
          return kill(pid, signal);
        });
      }
      await expect(recover()).rejects.toThrow("definitely dead original executor");
      expect(bytes()).toEqual(before);
    },
  );

  function retainedRecord(key: string, owner: string) {
    return { key, owner, payload: JSON.stringify(original()), updatedAt: 0 };
  }
  it.each<[string, () => Parameters<typeof seed>]>([
    ["child", () => [original(), `${installKey}/.openclaw-update-child-1`]],
    ["foreign", () => [original(), `${installKey}-foreign`]],
    ["bound", () => [{ ...original(), executor: { ...dead, pid: dead.pid - 1 } }]],
    ["custody", () => [{ ...original(), action: { ...original().action, custody: "bound" } }]],
    [
      "mirror",
      () => [
        {
          ...original(),
          mutationOriginal: retainedRecord(`${installKey}-original`, "original-owner"),
        },
      ],
    ],
    [
      "version4",
      () => [
        { ...original(), version: 4, cancellation: retainedRecord(installKey, "committed-owner") },
      ],
    ],
    ["unknown", () => [{ ...original(), futureWriter: true }]],
    ["repair-metadata", () => [original(), installKey, "retained recovery metadata"]],
  ])("preserves %s custody for its original recovery owner", async (_kind, seedArgs) => {
    seed(...seedArgs());
    const before = row();
    await expect(recover()).rejects.toThrow("foreign or retained executor custody");
    expect(row()).toEqual(before);
  });

  it("refuses recovery after the prepared rollback journal changes", async () => {
    seed();
    crash();
    const mainBytes = fs.readFileSync(databasePath);
    const prepare = rollback.prepareSqliteRollbackRecovery;
    let changedJournal: Buffer | undefined;
    vi.spyOn(rollback, "prepareSqliteRollbackRecovery").mockImplementation(async (params) => {
      const prepared = await prepare(params);
      fs.appendFileSync(`${databasePath}-journal`, "changed after snapshot");
      changedJournal = fs.readFileSync(`${databasePath}-journal`);
      return prepared;
    });
    await expect(recover()).rejects.toThrow("database or journal changed");
    expect(bytes()).toEqual([mainBytes, changedJournal]);
  });
});
