// Protects descriptor cleanup and competing sidecars after a Gateway lock write failure.
import fsSync, { type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";

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
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

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
      if (activeDescriptors.delete(fd)) {
        closeCalls += 1;
      }
      close(fd);
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

    await expect(
      acquireGatewayLock({ env, allowInTests: true, timeoutMs: 0, lockDir }),
    ).rejects.toMatchObject({
      name: "GatewayLockError",
      cause: writeError,
    });

    expect(opened).toHaveLength(1);
    expect(closeCalls).toBe(1);
    for (const fd of opened) {
      expect(() => fsSync.fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    }
    expect(foreignIdentity).toBeDefined();
    await expect(fs.lstat(stateLockPath, { bigint: true })).resolves.toMatchObject({
      dev: foreignIdentity?.dev,
      ino: foreignIdentity?.ino,
    });
    await expect(fs.readFile(stateLockPath, "utf8")).resolves.toBe("partial");
  });
});
