// Covers the production Gateway lock layout under an overridden state directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayLockDir } from "../config/paths.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import * as windowsProcessStart from "./windows-process-start.js";

type GatewayLock = NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>): GatewayLock {
  if (!lock) {
    throw new Error("Expected gateway lock");
  }
  return lock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("gateway lock state directory", () => {
  it.skipIf(process.platform !== "win32")(
    "reuses the current process identity across gateway lock lifetimes",
    async () => {
      const startTime = getFileLockProcessStartTime(process.pid);
      expect(startTime).not.toBeNull();
      const probe = vi.spyOn(windowsProcessStart, "readWindowsProcessStartTimeSync");
      await withTempDir("openclaw-gateway-lock-identity-", async (root) => {
        const env = {
          ...process.env,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        };
        await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}", "utf8");
        for (let index = 0; index < 2; index += 1) {
          const lock = expectGatewayLock(
            await acquireGatewayLock({ allowInTests: true, env, timeoutMs: 30 }),
          );
          try {
            for (const lockPath of [lock.lockPath, lock.stateLockPath]) {
              expect(JSON.parse(await fs.readFile(lockPath, "utf8"))).toMatchObject({
                pid: process.pid,
                startTime,
              });
            }
          } finally {
            await lock.release();
          }
        }
      });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("releases in-tree locks separately from Gateway lifecycle ownership", async () => {
    await withTempDir("openclaw-gateway-lock-release-", async (root) => {
      const stateDir = path.join(await fs.realpath(root), "state");
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(configPath, "{}", "utf8");
      const lock = expectGatewayLock(
        await acquireGatewayLock({
          allowInTests: true,
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeoutMs: 30,
        }),
      );

      await lock.releaseInTree();
      await fs.access(lock.lockPath);
      await expect(fs.access(lock.stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await lock.release();
    });
  });

  it("keeps one external process owner and a state-local compatibility projection", async () => {
    await withTempDir("openclaw-gateway-lock-state-", async (root) => {
      const canonicalRoot = await fs.realpath(root);
      const stateDir = path.join(canonicalRoot, "selected-state");
      const fakeHome = path.join(canonicalRoot, "home");
      const legacyTmpDir = path.join(canonicalRoot, "legacy-process-tmp");
      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(fakeHome, { recursive: true });
      await fs.mkdir(legacyTmpDir, { recursive: true });
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, "{}", "utf8");
      vi.spyOn(os, "tmpdir").mockReturnValue(legacyTmpDir);
      const env = {
        ...process.env,
        HOME: fakeHome,
        OPENCLAW_HOME: fakeHome,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
      };

      const lock = expectGatewayLock(
        await acquireGatewayLock({ allowInTests: true, env, timeoutMs: 30 }),
      );
      const lockDir = resolveGatewayLockDir(stateDir);
      const stateLockPath = path.join(lockDir, "gateway.state.lock");
      try {
        expect(lock.stateDir).toBe(stateDir);
        expect(lock.stateLockPath).toBe(stateLockPath);
        expect(lock.lockPath).toBe(
          resolveGatewayStateOwnerPath(path.join(stateDir, "state", "openclaw.sqlite")),
        );
        await expect(fs.access(`${lock.lockPath}.sqlite`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.access(`${lock.stateLockPath}.sqlite`)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await lock.release();
      }

      const reclaimPath = `${stateLockPath}.reclaim`;
      await fs.mkdir(reclaimPath);
      try {
        await expect(
          acquireGatewayLock({
            allowInTests: true,
            env,
            pollIntervalMs: 2,
            timeoutMs: 10,
          }),
        ).rejects.toBeInstanceOf(GatewayLockError);
        expect(reclaimPath.startsWith(`${stateDir}${path.sep}`)).toBe(true);
      } finally {
        await fs.rmdir(reclaimPath);
      }

      await expect(fs.readdir(legacyTmpDir)).resolves.toEqual([]);
      await expect(fs.access(path.join(fakeHome, ".openclaw"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("canonicalizes a missing state leaf through a symlinked parent", async () => {
    await withTempDir("openclaw-gateway-lock-symlink-", async (root) => {
      const canonicalRoot = await fs.realpath(root);
      const realParent = path.join(canonicalRoot, "real");
      const linkedParent = path.join(canonicalRoot, "linked");
      await fs.mkdir(realParent, { recursive: true });
      await fs.symlink(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");

      const linkedStateDir = path.join(linkedParent, "missing-state");
      const stateDir = path.join(realParent, "missing-state");
      const lockDir = resolveGatewayLockDir(stateDir);
      const lock = expectGatewayLock(
        await acquireGatewayLock({
          allowInTests: true,
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: path.join(linkedStateDir, "openclaw.json"),
            OPENCLAW_STATE_DIR: linkedStateDir,
          },
          timeoutMs: 30,
        }),
      );

      try {
        expect(lock.stateDir).toBe(stateDir);
        expect(lock.stateLockPath).toBe(path.join(lockDir, "gateway.state.lock"));
        expect(lock.lockPath).toBe(
          resolveGatewayStateOwnerPath(path.join(stateDir, "state", "openclaw.sqlite")),
        );
      } finally {
        await lock.release();
      }
    });
  });
});
