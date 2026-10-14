import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertManagedUpdateLeaseDatabaseIdentity,
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
  prepareManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import { prepareManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixture() {
  const root = fs.realpathSync(dirs.make("handoff-identity-"));
  const directory = path.join(root, "private-tmp");
  const databasePath = path.join(directory, "managed-update-handoffs.sqlite");
  // Opening SQLite retains an identity descriptor that prevents Windows parent renames.
  // These diagnostics need only a private file identity, not an admitted connection.
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(databasePath, "original", { mode: 0o600 });
  const binding = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  return { root, directory, databasePath, binding };
}

it.each(["file", "parent directory", "path", "missing file", "missing parent"] as const)(
  "explains a changed %s without accepting or repairing it",
  (change) => {
    vi.stubEnv("OPENCLAW_PROFILE", "diagnostic-test");
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    const { root, directory, databasePath, binding } = fixture();
    const retained = path.join(root, "retained");
    const original = fs.readFileSync(databasePath);
    let detail: string;
    let currentPath = databasePath;
    if (change === "file") {
      fs.renameSync(databasePath, retained);
      fs.writeFileSync(databasePath, original, { mode: 0o600 });
      const current = fs.lstatSync(databasePath, { bigint: true });
      detail = `file identity (recorded ${binding.databaseIdentity}; current ${current.dev}:${current.ino})`;
    } else if (change === "parent directory") {
      fs.renameSync(directory, retained);
      fs.mkdirSync(directory, { mode: 0o700 });
      fs.renameSync(path.join(retained, path.basename(databasePath)), databasePath);
      const current = fs.lstatSync(directory, { bigint: true });
      detail = `parent directory identity (recorded ${binding.parentIdentity}; current ${current.dev}:${current.ino})`;
    } else if (change === "path") {
      fs.renameSync(databasePath, retained);
      currentPath = retained;
      detail = `path (recorded ${binding.databasePath}; current ${retained})`;
    } else {
      fs.renameSync(change === "missing file" ? databasePath : directory, retained);
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

it.each(["prepare", "create"] as const)(
  "explains a different path at %s admission",
  async (owner) => {
    const { root, binding } = fixture();
    const current = path.join(root, "other.sqlite");
    const expected = `path (recorded ${binding.databasePath}; current ${current})`;
    if (owner === "prepare") {
      await expect(prepareManagedHandoffLeaseDatabase(current, binding)).rejects.toThrow(expected);
    } else {
      expect(() => createManagedHandoffLeaseDatabase(current, binding)).toThrow(expected);
    }
    expect(fs.existsSync(current)).toBe(false);
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "preserves original admission through a prepared parent (aliased ancestor=%s)",
  async (aliased) => {
    const directory = fs.realpathSync(dirs.make("handoff-original-parent-"));
    const root = path.join(directory, "install");
    const parent = path.join(directory, "private");
    fs.mkdirSync(root);
    fs.mkdirSync(parent, { mode: 0o700 });
    const alias = path.join(directory, "alias");
    fs.symlinkSync(directory, alias, "dir");
    const databasePath = path.join(aliased ? alias : directory, "private", "handoffs.sqlite");
    const canonical = path.join(parent, "handoffs.sqlite");
    const store = await prepareManagedHandoffLeaseStore({
      databasePath,
      serviceManagerEnv: process.env,
      originalUpdateKey: root,
    });
    const acquired = store.acquire(root, "original-owner", { kind: "update" });
    if (acquired.kind !== "acquired" || !acquired.originalDatabaseIdentity) {
      throw new Error("Original owner was not admitted");
    }
    expect(acquired.originalDatabaseIdentity.databasePath).toBe(canonical);
    const pinned = await prepareManagedHandoffLeaseStore({
      databasePath: canonical,
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
    expect(fs.existsSync(canonical + ".lock")).toBe(false);
  },
);

it("keeps nested prepared writers for different databases independently scoped", async () => {
  const directory = fs.realpathSync(dirs.make("handoff-nested-databases-"));
  const paths = ["first", "second"].map((name) => path.join(directory, name, "handoffs.sqlite"));
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
  const directory = fs.realpathSync(dirs.make("handoff-bound-parent-"));
  const parent = path.join(directory, "private");
  const canonical = path.join(parent, "handoffs.sqlite");
  const initial = await prepareManagedHandoffLeaseDatabase(canonical);
  initial(true, () => undefined);
  const alias = path.join(directory, "alias");
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const databasePath = path.join(alias, "private", "handoffs.sqlite");
  const ordinaryRealpath = fs.realpathSync;
  // Windows ordinary realpath can retain an 8.3 spelling. Keep the genuine
  // native resolver and Root; only model that already-recorded path spelling.
  vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
    const resolved = ordinaryRealpath(...args);
    return args[0] === databasePath && typeof resolved === "string" ? databasePath : resolved;
  });
  fs.realpathSync.native = ordinaryRealpath.native;
  const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  expect(identity.databasePath).toBe(databasePath);
  const pinned = await prepareManagedHandoffLeaseDatabase(databasePath, identity);
  pinned(true, () => undefined);
  expect(captureManagedUpdateLeaseDatabaseIdentity(databasePath)).toEqual(identity);
  expect(fs.existsSync(canonical + ".lock")).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "refuses a replaced prepared parent before creating storage",
  async () => {
    const root = fs.realpathSync(dirs.make("handoff-prepared-parent-"));
    const directory = path.join(root, "private");
    const databasePath = path.join(directory, "handoffs.sqlite");
    const prepared = await prepareManagedHandoffLeaseDatabase(databasePath);
    fs.renameSync(directory, path.join(root, "retained"));
    fs.mkdirSync(directory, { mode: 0o700 });
    expect(() => prepared(true, () => undefined)).toThrow();
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.readdirSync(path.join(root, "retained"))).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "quarantines an unsafe leaf without adopting its symlink target",
  async () => {
    const root = fs.realpathSync(dirs.make("handoff-prepared-leaf-"));
    const directory = path.join(root, "private");
    const target = path.join(root, "retained.sqlite");
    const databasePath = path.join(directory, "handoffs.sqlite");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(target, "retained external data", { mode: 0o600 });
    fs.symlinkSync(target, databasePath);
    const prepared = await prepareManagedHandoffLeaseDatabase(databasePath);
    prepared(true, () => undefined);
    expect(fs.readFileSync(target, "utf8")).toBe("retained external data");
    expect(fs.lstatSync(databasePath).isFile()).toBe(true);
    const retained = fs.readdirSync(directory).filter((name) => name.includes(".unsafe-file."));
    expect(retained).toHaveLength(1);
    expect(fs.readlinkSync(path.join(directory, retained[0]!))).toBe(target);
    expect(fs.existsSync(databasePath + ".lock")).toBe(false);
  },
);
