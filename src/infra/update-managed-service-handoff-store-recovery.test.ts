import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withConfigWriteLock } from "../config/write-lock.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: () => fixture.root }));

// The repair and the mode check it restores are POSIX-only: assertPath skips the
// permission bits on win32, where fs.chmodSync does not implement them.
const unix = process.platform === "win32" ? it.skip : it;

let configPath: string;
let databasePath: string;

beforeEach(() => {
  fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-store-")));
  fs.chmodSync(fixture.root, 0o700);
  configPath = path.join(fixture.root, "openclaw.json");
  databasePath = path.join(fixture.root, "managed-update-handoffs.sqlite");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

/** Stop where a crash would: `open` creates the file before the store chmods it. */
function interruptFirstWrite() {
  openNodeSqliteDatabase(databasePath, { readOnly: false }).close();
  fs.chmodSync(databasePath, 0o644);
}
const fileMode = () => fs.statSync(databasePath).mode & 0o777;

function writeConfig() {
  const callback = vi.fn(async () => {
    fs.writeFileSync(configPath, "{}");
  });
  return { callback, done: withConfigWriteLock(configPath, callback, {}) };
}

unix("recovers a store left world-readable by an interrupted first write", async () => {
  interruptFirstWrite();
  expect(fileMode()).toBe(0o644);

  const { callback, done } = writeConfig();
  await expect(done).resolves.toBeUndefined();
  expect(callback).toHaveBeenCalledTimes(1);
  // Repaired in place, not merely tolerated: the next reader finds the invariant.
  expect(fileMode()).toBe(0o600);
});

unix("keeps the private mode once an ordinary lease has been admitted", () => {
  const store = createManagedHandoffLeaseStore();
  const install = path.join(fixture.root, "install");
  fs.mkdirSync(install);
  expect(store.acquire(install, "owner", { kind: "update" }).kind).toBe("acquired");
  expect(fileMode()).toBe(0o600);
});

unix.each([false, true])(
  "forwards transaction warnings to the handoff sink (existing: %s)",
  (existing) => {
    const options = { databasePath, serviceManagerEnv: {} };
    const originalInstall = path.join(fixture.root, "original");
    const nextInstall = path.join(fixture.root, "next");
    fs.mkdirSync(originalInstall);
    fs.mkdirSync(nextInstall);
    expect(
      createManagedHandoffLeaseStore(options).acquire(originalInstall, "original", {
        kind: "update",
      }).kind,
    ).toBe("acquired");
    const logger = { warn: vi.fn() };
    const store = createManagedHandoffLeaseStore(
      {
        ...options,
        existingIdentity: existing
          ? captureManagedUpdateLeaseDatabaseIdentity(databasePath)
          : undefined,
      },
      logger,
    );
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // oxlint-disable-next-line typescript/unbound-method -- exec.call restores the actual database receiver.
    const exec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      const result = exec.call(this, sql);
      if (sql === "BEGIN IMMEDIATE" || sql === "COMMIT") {
        now += 1_000;
      }
      return result;
    });
    expect(store.acquire(nextInstall, "next", { kind: "update" }).kind).toBe("acquired");
    expect(logger.warn).toHaveBeenCalledTimes(2);
    for (const step of ["begin", "commit"]) {
      expect(logger.warn).toHaveBeenCalledWith(
        "slow SQLite transaction lock wait",
        expect.objectContaining({ step, elapsedMs: 1_000, async: false }),
      );
    }
    expect(store.read(originalInstall)).toMatchObject({
      kind: "current",
      lease: { owner: "original" },
    });
    expect(store.read(nextInstall)).toMatchObject({ kind: "current", lease: { owner: "next" } });
  },
);

const retainedStores = () =>
  fs.readdirSync(fixture.root).filter((name) => name.includes(".sqlite.unsafe-file."));

unix.each([0o664, 0o666, 0o602])(
  "recovers a store that was writable by others (%s)",
  async (mode) => {
    interruptFirstWrite();
    // chmod cannot revoke a descriptor another user already opened, so these
    // contents are never adopted. They are retained for diagnosis instead, and
    // the caller continues against a store that replaces them.
    fs.chmodSync(databasePath, mode);

    const { callback, done } = writeConfig();
    await expect(done).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(retainedStores()).toHaveLength(1);
  },
);

unix("recovers a store owned by another user without adopting it", async () => {
  interruptFirstWrite();
  const foreignIno = fs.lstatSync(databasePath).ino;
  const realLstatSync = fs.lstatSync.bind(fs);
  // Only the original inode is foreign. The store that replaces it is ours, which
  // is what makes the recovery converge instead of quarantining on every call.
  vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...rest: never[]) => {
    const stat = realLstatSync(target, ...rest);
    // Keep the Stats prototype so isFile()/isSymbolicLink() stay real.
    return stat.ino === foreignIno
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 })
      : stat;
  }) as typeof fs.lstatSync);

  const { callback, done } = writeConfig();
  await expect(done).resolves.toBeUndefined();
  expect(callback).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
  expect(retainedStores()).toHaveLength(1);
  expect(fileMode()).toBe(0o600);
});

// The repair relies on this: a private directory is what makes excess read bits
// on the file defense in depth rather than a real exposure.
unix("restores a directory that stopped being private", () => {
  const store = createManagedHandoffLeaseStore();
  const install = path.join(fixture.root, "install");
  fs.mkdirSync(install);
  expect(store.acquire(install, "owner", { kind: "update" }).kind).toBe("acquired");
  fs.chmodSync(fixture.root, 0o755);

  expect(() => store.assertSourceUnborrowed(configPath)).not.toThrow();
  expect(fs.statSync(fixture.root).mode & 0o777).toBe(0o700);
});

// Recovery is serialized and the decision retaken under the lock, because acting
// on an observation taken before another repairer's rename would quarantine the
// clean store it just installed, leaving two authoritative databases. The
// interleaving itself spans processes and is not reproduced here; this pins the
// visible outcome, that repairing a defect converges on exactly one live store.
unix("converges on one live store and one retained copy", () => {
  interruptFirstWrite();
  fs.chmodSync(databasePath, 0o666);

  for (const store of [createManagedHandoffLeaseStore(), createManagedHandoffLeaseStore()]) {
    expect(() => store.assertSourceUnborrowed(configPath)).not.toThrow();
  }

  expect(retainedStores()).toHaveLength(1);
  expect(fileMode()).toBe(0o600);
  // The repair lock is released, so the next caller is not left waiting on it.
  expect(fs.existsSync(`${databasePath}.lock`)).toBe(false);
});
