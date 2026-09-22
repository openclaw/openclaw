// Protects descriptor cleanup and competing sidecars after a Gateway lock write failure.
import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireGatewayLock } from "./gateway-lock.js";

const fixtureRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-gateway-write-failure-",
});
const realNow = Date.now.bind(Date);

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
    const open = fs.open;
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    let closeCalls = 0;
    let foreignIdentity: BigIntStats | undefined;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[1] === "wx") {
        opened.push(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => {
          closeCalls += 1;
          await close();
        });
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          // A competing writer replaces the pathname while the admitted inode stays open.
          await fs.rename(stateLockPath, `${stateLockPath}.opened`);
          await fs.writeFile(stateLockPath, "partial", "utf8");
          foreignIdentity = await fs.lstat(stateLockPath, { bigint: true });
          throw writeError;
        });
      }
      return handle;
    });

    await withEnvAsync({ FS_SAFE_NATIVE_MODE: "off" }, async () => {
      await expect(
        acquireGatewayLock({
          env,
          allowInTests: true,
          timeoutMs: 30,
          pollIntervalMs: 2,
          now: realNow,
          sleep: async (ms) => {
            await nativeSleep(ms);
          },
          lockDir,
        }),
      ).rejects.toMatchObject({
        name: "GatewayLockError",
        cause: writeError,
      });
    });

    expect(opened).toHaveLength(1);
    expect(closeCalls).toBe(1);
    for (const handle of opened) {
      await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
    }
    expect(foreignIdentity).toBeDefined();
    await expect(fs.lstat(stateLockPath, { bigint: true })).resolves.toMatchObject({
      dev: foreignIdentity?.dev,
      ino: foreignIdentity?.ino,
    });
    await expect(fs.readFile(stateLockPath, "utf8")).resolves.toBe("partial");

    openSpy.mockRestore();
  });
});
