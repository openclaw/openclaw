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

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

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
