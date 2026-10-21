import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withConfigWriteLock } from "../config/write-lock.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: () => fixture.root }));

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

// Simulate a crash between file creation and permission repair.
function interruptFirstWrite(mode = 0o644) {
  openNodeSqliteDatabase(databasePath, { readOnly: false }).close();
  fs.chmodSync(databasePath, mode);
}
const fileMode = () => fs.statSync(databasePath).mode & 0o777;
const retainedStores = () =>
  fs.readdirSync(fixture.root).filter((name) => name.includes(".sqlite.unsafe-file."));
async function writeConfig() {
  const callback = vi.fn(async () => {
    fs.writeFileSync(configPath, "{}");
  });
  await expect(withConfigWriteLock(configPath, callback, {})).resolves.toBeUndefined();
  expect(callback).toHaveBeenCalledTimes(1);
}

function acquireLease() {
  const store = createManagedHandoffLeaseStore();
  const install = path.join(fixture.root, "install");
  fs.mkdirSync(install);
  expect(store.acquire(install, "owner", { kind: "update" }).kind).toBe("acquired");
  return store;
}

unix("recovers a store left world-readable by an interrupted first write", async () => {
  interruptFirstWrite();
  expect(fileMode()).toBe(0o644);
  await writeConfig();
  expect(fileMode()).toBe(0o600);
});

unix("keeps the private mode once an ordinary lease has been admitted", () => {
  acquireLease();
  expect(fileMode()).toBe(0o600);
});

unix.each([0o664, 0o666, 0o602])("quarantines a writable store (%s)", async (mode) => {
  interruptFirstWrite(mode);
  await writeConfig();
  expect(retainedStores()).toHaveLength(1);
});

unix("recovers a store owned by another user without adopting it", async () => {
  interruptFirstWrite();
  const foreignIno = fs.lstatSync(databasePath).ino;
  const realLstatSync = fs.lstatSync.bind(fs);
  // Only the original inode is foreign; its replacement must remain adoptable.
  vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...rest: never[]) => {
    const stat = realLstatSync(target, ...rest);
    return stat?.ino === foreignIno
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: stat.uid + 1 })
      : stat;
  }) as typeof fs.lstatSync);
  await writeConfig();
  vi.restoreAllMocks();
  expect(retainedStores()).toHaveLength(1);
  expect(fileMode()).toBe(0o600);
});

unix("restores a directory that stopped being private", () => {
  const store = acquireLease();
  fs.chmodSync(fixture.root, 0o755);
  expect(() => store.assertSourceUnborrowed(configPath)).not.toThrow();
  expect(fs.statSync(fixture.root).mode & 0o777).toBe(0o700);
});

unix("converges on one live store and one retained copy", () => {
  interruptFirstWrite(0o666);
  for (const store of [createManagedHandoffLeaseStore(), createManagedHandoffLeaseStore()]) {
    expect(() => store.assertSourceUnborrowed(configPath)).not.toThrow();
  }
  expect(retainedStores()).toHaveLength(1);
  expect(fileMode()).toBe(0o600);
  expect(fs.existsSync(`${databasePath}.lock`)).toBe(false);
});
