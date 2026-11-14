import fsSync, { type BigIntStats, chmodSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, chmodSync: vi.fn(original.chmodSync) };
});

const roots = useAutoCleanupTempDirTracker(afterEach);
const acquire = (options: Parameters<typeof acquireGatewayLock>[0]) =>
  acquireGatewayLock({ allowInTests: true, timeoutMs: 0, ...options });

beforeEach(() => {
  vi.mocked(chmodSync).mockImplementation(fsSync.chmodSync);
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform === "win32")(
  "acquires a writable database on a filesystem that rejects chmod",
  async () => {
    const stateDir = roots.make("chmod-unsupported");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    const options = {
      env: { OPENCLAW_STATE_DIR: stateDir },
      listenerMode: "supervised" as const,
      supervisor: { kind: "systemd" as const, name: null },
      port: 12345,
    };
    await (await acquire(options))?.release();
    await fs.chmod(databasePath, 0o666);
    const chmod = fsSync.chmodSync.bind(fsSync);
    vi.mocked(chmodSync).mockImplementation((pathname, mode) => {
      if (String(pathname).startsWith(path.dirname(databasePath))) {
        throw Object.assign(new Error("filesystem does not support chmod"), { code: "EPERM" });
      }
      chmod(pathname, mode);
    });
    const lock = await acquire(options);
    try {
      expect(lock).not.toBeNull();
      expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o666);
    } finally {
      await lock?.release();
    }
  },
);

it("closes handle and preserves an unowned lock file when writeFile fails after open succeeds", async () => {
  const stateDir = roots.make("gateway-write-failure");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const lockDir = path.join(stateDir, "__locks");
  await fs.mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, "gateway.state.lock");

  const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const open = fsSync.openSync.bind(fsSync);
  const write = fsSync.writeFileSync.bind(fsSync);
  const close = fsSync.closeSync.bind(fsSync);
  const descriptors = { opened: 0, closed: 0 };
  const activeDescriptors = new Set<number>();
  let foreignIdentity: BigIntStats | undefined;
  vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
    const fd = open(pathname, flags, mode);
    if (pathname === lockPath && typeof flags === "number" && flags & fsSync.constants.O_EXCL) {
      descriptors.opened += 1;
      activeDescriptors.add(fd);
    }
    return fd;
  });
  vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
    close(fd);
    // A closed descriptor number can be reused before acquisition rejects.
    if (activeDescriptors.delete(fd)) {
      descriptors.closed += 1;
    }
  });
  vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, data, options) => {
    if (typeof file === "number" && activeDescriptors.has(file)) {
      // A competing writer replaces the pathname while the admitted inode stays open.
      fsSync.renameSync(lockPath, `${lockPath}.opened`);
      write(lockPath, "partial", "utf8");
      foreignIdentity = fsSync.lstatSync(lockPath, { bigint: true });
      throw writeError;
    }
    write(file, data, options);
  });

  const failure = await acquire({ env, lockDir }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(GatewayLockError);
  expect(failure).toMatchObject({ cause: writeError, databasePath: undefined });

  expect(descriptors).toEqual({ opened: 1, closed: 1 });
  expect(foreignIdentity).toBeDefined();
  await expect(fs.lstat(lockPath, { bigint: true })).resolves.toMatchObject({
    dev: foreignIdentity?.dev,
    ino: foreignIdentity?.ino,
  });
  await expect(fs.readFile(lockPath, "utf8")).resolves.toBe("partial");
});
