// Protects descriptor cleanup and competing sidecars after a Gateway lock write failure.
import fsSync, { type BigIntStats, chmodSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, chmodSync: vi.fn(original.chmodSync) };
});

const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-gateway-write-failure-",
});

describe("gateway lock write failure", () => {
  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(chmodSync).mockImplementation(fsSync.chmodSync);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  it.skipIf(process.platform === "win32")(
    "acquires a writable database on a filesystem that rejects chmod",
    async () => {
      const stateDir = await fixtureRootTracker.make("chmod-unsupported");
      const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
      const options = {
        env: { OPENCLAW_STATE_DIR: stateDir },
        allowInTests: true,
        timeoutMs: 0,
        listenerMode: "supervised" as const,
        supervisor: { kind: "systemd" as const, name: null },
        port: 12345,
      };
      const initial = await acquireGatewayLock(options);
      await initial?.release();
      await fs.chmod(databasePath, 0o666);
      const chmod = fsSync.chmodSync.bind(fsSync);
      const chmodSpy = vi.mocked(chmodSync).mockImplementation((pathname, mode) => {
        if (String(pathname).startsWith(path.dirname(databasePath))) {
          throw Object.assign(new Error("filesystem does not support chmod"), { code: "EPERM" });
        }
        chmod(pathname, mode);
      });
      const lock = await acquireGatewayLock(options);
      try {
        expect(lock).not.toBeNull();
        expect(chmodSpy).toHaveBeenCalledWith(databasePath, 0o600);
        expect((await fs.stat(databasePath)).mode & 0o777).toBe(0o666);
      } finally {
        await lock?.release();
      }
    },
  );

  it("closes handle and preserves an unowned lock file when writeFile fails after open succeeds", async () => {
    vi.useRealTimers();
    const stateDir = await fixtureRootTracker.make("case");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    const lockDir = path.join(stateDir, "__locks");
    await fs.mkdir(lockDir, { recursive: true });
    const stateLockPath = path.join(lockDir, "gateway.state.lock");

    const writeError = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
    const open = fsSync.openSync.bind(fsSync);
    const write = fsSync.writeFileSync.bind(fsSync);
    const close = fsSync.closeSync.bind(fsSync);
    const opened: number[] = [];
    const activeDescriptors = new Set<number>();
    let closeCalls = 0;
    let foreignIdentity: BigIntStats | undefined;
    vi.spyOn(fsSync, "openSync").mockImplementation((pathname, flags, mode) => {
      const fd = open(pathname, flags, mode);
      if (
        pathname === stateLockPath &&
        typeof flags === "number" &&
        flags & fsSync.constants.O_EXCL
      ) {
        opened.push(fd);
        activeDescriptors.add(fd);
      }
      return fd;
    });
    vi.spyOn(fsSync, "closeSync").mockImplementation((fd) => {
      close(fd);
      // A closed descriptor number can be reused before acquisition rejects.
      if (activeDescriptors.delete(fd)) {
        closeCalls += 1;
      }
    });
    vi.spyOn(fsSync, "writeFileSync").mockImplementation((file, data, options) => {
      if (typeof file === "number" && activeDescriptors.has(file)) {
        // A competing writer replaces the pathname while the admitted inode stays open.
        fsSync.renameSync(stateLockPath, `${stateLockPath}.opened`);
        write(stateLockPath, "partial", "utf8");
        foreignIdentity = fsSync.lstatSync(stateLockPath, { bigint: true });
        throw writeError;
      }
      write(file, data, options);
    });

    const failure = await acquireGatewayLock({
      env,
      allowInTests: true,
      timeoutMs: 0,
      lockDir,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayLockError);
    expect(failure).toMatchObject({ cause: writeError, databasePath: undefined });

    expect(opened).toHaveLength(1);
    expect(closeCalls).toBe(1);
    expect(foreignIdentity).toBeDefined();
    await expect(fs.lstat(stateLockPath, { bigint: true })).resolves.toMatchObject({
      dev: foreignIdentity?.dev,
      ino: foreignIdentity?.ino,
    });
    await expect(fs.readFile(stateLockPath, "utf8")).resolves.toBe("partial");
  });
});
