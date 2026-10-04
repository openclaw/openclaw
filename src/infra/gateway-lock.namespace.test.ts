import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import {
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  readActiveGatewayLockIdentity,
  resolveGatewayLockPaths,
  resolveGatewayOwnerStatus,
} from "./gateway-lock.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";

type GatewayLockOptions = NonNullable<Parameters<typeof acquireGatewayLock>[0]>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function resolveTestLockDir(env: NodeJS.ProcessEnv) {
  return path.join(resolveStateDir(env), "__locks");
}

async function makeEnv() {
  const dir = tempDirs.make("openclaw-gateway-lock-namespace-");
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  return { ...process.env, OPENCLAW_STATE_DIR: dir, OPENCLAW_CONFIG_PATH: configPath };
}

async function acquireForTest(
  env: NodeJS.ProcessEnv,
  opts: Omit<GatewayLockOptions, "env" | "allowInTests"> = {},
) {
  return acquireGatewayLock({
    env,
    allowInTests: true,
    timeoutMs: 0,
    lockDir: resolveTestLockDir(env),
    ...opts,
  });
}

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>) {
  if (lock === null) {
    throw new Error("Expected gateway lock");
  }
  expect(typeof lock.release).toBe("function");
  return lock;
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
  fsSync.mkdirSync(path.dirname(paths.configLockPath), { recursive: true });
  return { lockPath: paths.configLockPath, configPath: paths.configPath };
}

function createLockPayload(params: { configPath: string; startTime: number; port?: number }) {
  return {
    pid: process.pid,
    createdAt: new Date().toISOString(),
    configPath: params.configPath,
    ...(params.port ? { port: params.port } : {}),
    startTime: params.startTime,
  };
}

function mockLinuxNamespace(root: string) {
  if (process.platform !== "linux") {
    vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    const stat = fsSync.statSync.bind(fsSync);
    vi.spyOn(fsSync, "statSync").mockImplementation((file, options) =>
      stat(file === "/proc/self/ns/pid" ? root : file, options),
    );
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readGatewayLockProcessNamespace();
    platform.mockRestore();
  }
  const namespace = readGatewayLockProcessNamespace();
  if (!namespace || !("pidNsInode" in namespace)) {
    throw new Error("Expected Linux process namespace identity");
  }
  return namespace;
}

describe("gateway lock namespaces", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes boot and PID namespace identity in both ownership sidecars", async () => {
    const env = await makeEnv();
    const gateway = expectGatewayLock(await acquireForTest(env));
    try {
      for (const pathname of [gateway.lockPath, gateway.stateLockPath]) {
        const payload = parseGatewayLockPayload(await fs.readFile(pathname, "utf8"));
        expect(payload?.processNamespace).toEqual({
          host: os.hostname(),
          platform: process.platform,
          identity: expect.any(String),
          ...(process.platform === "linux"
            ? { pidNsInode: fsSync.statSync("/proc/self/ns/pid", { bigint: true }).ino.toString() }
            : {}),
        });
      }
    } finally {
      await gateway.release();
    }
  });

  it.each(["darwin", "win32"] as const)(
    "uses PID evidence on %s only for local or legacy namespace identity",
    async (platform) => {
      if (platform !== process.platform) {
        vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
          platform,
          identity:
            platform === "darwin"
              ? "01234567-89ab-cdef-0123-456789abcdef"
              : "2026-10-01T00:00:00.0000000Z",
        }));
      }
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const namespace = readGatewayLockProcessNamespace();
      for (const processNamespace of [
        undefined,
        null,
        namespace,
        {
          host: os.hostname(),
          platform: "linux" as const,
          identity: "01234567-89ab-cdef-0123-456789abcdef",
          pidNsInode: "foreign",
        },
      ]) {
        const payload = {
          ...createLockPayload({ configPath: "/unused", startTime: 123 }),
          processNamespace,
        };
        const comparable = !processNamespace || processNamespace.platform === platform;
        await expect(resolveGatewayOwnerStatus(2_147_483_647, payload, platform)).resolves.toBe(
          comparable ? "dead" : "unknown",
        );
        await expect(
          resolveGatewayOwnerStatus(process.pid, payload, platform, undefined, () => 123),
        ).resolves.toBe(comparable ? "alive" : "unknown");
        await expect(
          resolveGatewayOwnerStatus(process.pid, payload, platform, undefined, () => 124),
        ).resolves.toBe(comparable ? "dead" : "unknown");
      }
    },
  );

  it.each(["darwin", "win32"] as const)(
    "does not repeat an unavailable %s boot subprocess during owner admission",
    async (platform) => {
      const otherPlatform = platform === "darwin" ? "win32" : "darwin";
      const observedPlatform = vi.spyOn(process, "platform", "get").mockReturnValue(otherPlatform);
      const boot = vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader");
      boot.mockReturnValue(() => ({
        platform: otherPlatform,
        identity:
          otherPlatform === "darwin"
            ? "01234567-89ab-cdef-0123-456789abcdef"
            : "2026-10-01T00:00:00.0000000Z",
      }));
      // Move the observation to another platform before exercising a failed probe.
      readGatewayLockProcessNamespace();
      observedPlatform.mockReturnValue(platform);
      const probe = vi.fn(() => {
        throw Object.assign(new Error("boot subprocess timed out"), { code: "ETIMEDOUT" });
      });
      boot.mockReturnValue(probe);
      const payload = {
        ...createLockPayload({ configPath: "/unused", startTime: 123 }),
        processNamespace: null,
      };
      await expect(resolveGatewayOwnerStatus(2_147_483_647, payload, platform)).resolves.toBe(
        "dead",
      );
      await expect(
        resolveGatewayOwnerStatus(process.pid, payload, platform, undefined, () => 123),
      ).resolves.toBe("alive");
      await expect(
        resolveGatewayOwnerStatus(process.pid, payload, platform, undefined, () => 124),
      ).resolves.toBe("dead");
      expect(probe).toHaveBeenCalledOnce();
    },
  );

  it.each(["boot identity", "PID namespace"] as const)(
    "preserves fresh ownership and reclaims an expired heartbeat when the Linux %s probe fails",
    async (probe) => {
      const env = await makeEnv();
      const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
      const record = JSON.stringify({
        ...createLockPayload({ configPath: paths.configPath, startTime: 1 }),
        pid: 2_147_483_647,
        processNamespace: {
          host: os.hostname(),
          platform: "linux",
          identity: "01234567-89ab-cdef-0123-456789abcdef",
          pidNsInode: "foreign",
        },
      });
      await fs.mkdir(path.dirname(paths.ownerLockPath), { recursive: true });
      await fs.writeFile(paths.ownerLockPath, record);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const boot = vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader");
      boot.mockReturnValue(() => ({
        platform: "darwin",
        identity: "01234567-89ab-cdef-0123-456789abcdef",
      }));
      // A successful observation belongs to one platform; discard a prior Linux fixture's cache.
      readGatewayLockProcessNamespace();
      platform.mockReturnValue("linux");
      boot.mockReturnValue(() => {
        if (probe === "boot identity") {
          throw Object.assign(new Error("boot identity unavailable"), { code: "EACCES" });
        }
        return { platform: "linux", identity: "01234567-89ab-cdef-0123-456789abcdef" };
      });
      const stat = fsSync.statSync.bind(fsSync);
      vi.spyOn(fsSync, "statSync").mockImplementation((file, options) => {
        if (file === "/proc/self/ns/pid") {
          throw Object.assign(new Error("PID namespace unavailable"), { code: "EACCES" });
        }
        return stat(file, options);
      });
      expect(readGatewayLockProcessNamespace()).toBeNull();
      let unexpected: Awaited<ReturnType<typeof acquireForTest>> | undefined;
      try {
        await expect(
          acquireForTest(env, { role: "sqlite-maintenance" }).then((owner) => {
            unexpected = owner;
            return owner;
          }),
        ).rejects.toThrow("cannot verify Gateway ownership from this process");
      } finally {
        await unexpected?.release();
      }
      await expect(fs.readFile(paths.ownerLockPath, "utf8")).resolves.toBe(record);
      const expired = new Date(Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1000);
      await fs.utimes(paths.ownerLockPath, expired, expired);
      const owner = expectGatewayLock(await acquireForTest(env, { role: "sqlite-maintenance" }));
      try {
        owner.assertCurrent();
        expect(await fs.readFile(paths.ownerLockPath, "utf8")).not.toBe(record);
      } finally {
        await owner.release();
      }
    },
  );

  it.each(["crashed", "renewing"] as const)(
    "bounds startup recovery for a %s foreign-namespace owner",
    async (kind) => {
      const env = await makeEnv();
      const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
      vi.useFakeTimers();
      const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
      const payload = JSON.stringify({
        ...createLockPayload({ configPath: paths.configPath, startTime: 1 }),
        pid: 2_147_483_647,
        processNamespace: { ...namespace, pidNsInode: "foreign-namespace" },
      });
      for (const file of [paths.ownerLockPath, paths.stateLockPath]) {
        fsSync.mkdirSync(path.dirname(file), { recursive: true });
        fsSync.writeFileSync(file, payload);
        fsSync.utimesSync(file, new Date(), new Date());
      }
      const fsync = fsSync.fsyncSync.bind(fsSync);
      vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
        fsync(fd);
        // Native file timestamps must follow the same fake clock as startup admission.
        fsSync.futimesSync(fd, new Date(), new Date());
      });
      const renew =
        kind === "renewing"
          ? setInterval(() => {
              for (const file of [paths.ownerLockPath, paths.stateLockPath]) {
                fsSync.utimesSync(file, new Date(), new Date());
              }
            }, 15_000)
          : undefined;
      const waiting = createDeferred();
      const delays: number[] = [];
      let completed = false;
      const startup = acquireGatewayLock({
        allowInTests: true,
        env,
        lockDir: resolveTestLockDir(env),
        now: Date.now,
        sleep: (ms) => {
          delays.push(ms);
          waiting.resolve();
          return new Promise((resolve) => {
            setTimeout(resolve, ms);
          });
        },
      }).then(
        (lock) => {
          completed = true;
          return { lock };
        },
        (error: unknown) => ({ error }),
      );
      let gateway: Awaited<ReturnType<typeof acquireGatewayLock>> | undefined;
      try {
        await awaitGateBeforeSettlement(
          waiting.promise,
          startup,
          "Gateway startup settled before waiting for the owner heartbeat",
        );
        await vi.advanceTimersByTimeAsync(85_000);
        expect(completed).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        const outcome = await startup;
        expect(delays.length).toBeGreaterThanOrEqual(18);
        expect(delays.length).toBeLessThanOrEqual(19);
        expect(delays.every((delay) => delay === 5000)).toBe(true);
        if (kind === "crashed") {
          if (!("lock" in outcome)) {
            throw outcome.error;
          }
          gateway = outcome.lock;
          expectGatewayLock(gateway).assertCurrent();
          expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).not.toBe(payload);
        } else {
          expect(outcome).toEqual({ error: expect.any(GatewayLockError) });
          expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).toBe(payload);
        }
      } finally {
        clearInterval(renew);
        await gateway?.release();
      }
    },
  );

  it.each(["PID namespace", "host and boot"] as const)(
    "preserves a historical projection from a different %s before acquiring Gateway ownership",
    async (difference) => {
      const env = await makeEnv();
      const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
      const { lockPath, configPath } = resolveLockPath(env);
      const payload = {
        ...createLockPayload({ configPath, startTime: 1, port: 18789 }),
        pid: 2_147_483_647,
        processNamespace:
          difference === "PID namespace"
            ? { ...namespace, pidNsInode: "foreign-namespace" }
            : {
                ...namespace,
                host: `${namespace.host}-other`,
                identity: namespace.identity.replace(/[0-9a-f]/i, (digit) =>
                  digit === "1" ? "2" : "1",
                ),
              },
      };
      const record = JSON.stringify(payload);
      await fs.writeFile(lockPath, record);
      await expect(resolveGatewayOwnerStatus(payload.pid, payload, process.platform)).resolves.toBe(
        "unknown",
      );
      await expect(acquireForTest(env, { timeoutMs: 0 })).rejects.toThrow(
        "cannot verify Gateway ownership from this process",
      );
      await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(record);
      const inspection = readActiveGatewayLockIdentity({
        env,
        lockDir: resolveTestLockDir(env),
        requireInspection: true,
      });
      await expect(inspection).rejects.toBeInstanceOf(GatewayLockError);
      await expect(inspection).rejects.toThrow("with a shared PID namespace");
    },
  );
});
