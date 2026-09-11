import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withConfigWriteLock } from "../config/write-lock.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
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

// The repair relies on this: a private directory is what makes excess bits on the
// file defense in depth rather than a real exposure, so it must keep refusing.
unix("still refuses once the containing directory stops being private", () => {
  const store = createManagedHandoffLeaseStore();
  const install = path.join(fixture.root, "install");
  fs.mkdirSync(install);
  expect(store.acquire(install, "owner", { kind: "update" }).kind).toBe("acquired");
  fs.chmodSync(fixture.root, 0o755);

  expect(() => store.assertSourceUnborrowed(configPath)).toThrow(
    "managed handoff lease directory is unsafe",
  );
});

unix.each([0o664, 0o666, 0o602])(
  "still refuses a store that was writable by others (%s)",
  async (mode) => {
    interruptFirstWrite();
    // chmod cannot revoke a descriptor another user already opened, so tightening
    // the path afterwards would not make these rows trustworthy.
    fs.chmodSync(databasePath, mode);

    const { callback, done } = writeConfig();
    await expect(done).rejects.toThrow("managed handoff lease file is unsafe");
    expect(callback).not.toHaveBeenCalled();
    expect(fileMode()).toBe(mode);
  },
);

unix("still refuses a store owned by another user", async () => {
  interruptFirstWrite();
  const realLstatSync = fs.lstatSync.bind(fs);
  vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...rest: never[]) => {
    const stat = realLstatSync(target, ...rest);
    // Keep the Stats prototype so isFile()/isSymbolicLink() stay real.
    return String(target) === databasePath
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 })
      : stat;
  }) as typeof fs.lstatSync);

  const { callback, done } = writeConfig();
  await expect(done).rejects.toThrow("managed handoff lease file is unsafe");
  expect(callback).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  // A foreign owner is never repaired away.
  expect(fileMode()).toBe(0o644);
});
