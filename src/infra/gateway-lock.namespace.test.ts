import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveStateDir } from "../config/paths.js";
import {
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
          boot: { platform: process.platform, identity: expect.any(String) },
          pidNamespace:
            process.platform === "linux"
              ? fsSync.statSync("/proc/self/ns/pid", { bigint: true }).ino.toString()
              : "host",
        });
      }
    } finally {
      await gateway.release();
    }
  });

  it.each(["crashed", "renewing"] as const)(
    "bounds startup recovery for a %s foreign-namespace owner",
    async (kind) => {
      const env = await makeEnv();
      const namespace = readGatewayLockProcessNamespace();
      if (!namespace) {
        throw new Error("Expected local boot and PID namespace identity");
      }
      vi.useFakeTimers();
      const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
      const payload = JSON.stringify({
        ...createLockPayload({ configPath: paths.configPath, startTime: 1 }),
        pid: 2_147_483_647,
        processNamespace: { ...namespace, pidNamespace: "foreign-namespace" },
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

  it.each(["foreign", "unavailable"] as const)(
    "preserves a %s-namespace historical projection before acquiring Gateway ownership",
    async (kind) => {
      const env = await makeEnv();
      const namespace = readGatewayLockProcessNamespace();
      if (!namespace) {
        throw new Error("Expected local boot and PID namespace identity");
      }
      const { lockPath, configPath } = resolveLockPath(env);
      const payload = {
        ...createLockPayload({ configPath, startTime: 1, port: 18789 }),
        pid: 2_147_483_647,
        processNamespace:
          kind === "unavailable" ? null : { ...namespace, pidNamespace: "foreign-namespace" },
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
