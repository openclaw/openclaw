import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  prepareManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import { prepareManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

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

it.skipIf(isWindows).each([false, true])(
  "preserves original admission through a prepared parent (aliased ancestor=%s)",
  async (aliased) => {
    fs.mkdirSync(directory, { mode: 0o700 });
    const alias = aliasedPath();
    const store = await prepareManagedHandoffLeaseStore({
      databasePath: aliased ? alias : databasePath,
      serviceManagerEnv: process.env,
      originalUpdateKey: root,
    });
    const acquired = store.acquire(root, "original-owner", { kind: "update" });
    if (acquired.kind !== "acquired" || !acquired.originalDatabaseIdentity) {
      throw new Error("Original owner was not admitted");
    }
    expect(acquired.originalDatabaseIdentity.databasePath).toBe(databasePath);
    const pinned = await prepareManagedHandoffLeaseStore({
      databasePath,
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
  pinned(true, () => undefined);
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
