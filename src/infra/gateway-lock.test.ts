// Tests gateway lock file ownership and stale-lock behavior.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
  resolveGatewayOwnerStatus,
} from "./gateway-lock.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";

type GatewayLock = NonNullable<Awaited<ReturnType<typeof acquireGatewayLock>>>;
type GatewayLockOptions = NonNullable<Parameters<typeof acquireGatewayLock>[0]>;

const fixtureRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-lock-" });
const realNow = Date.now.bind(Date);
const lifecycleChildren = new Map<ChildProcess, Promise<unknown[]>>();
const lifecycleDatabases = new Set<string>();

function resolveTestLockDir(env: NodeJS.ProcessEnv) {
  return path.join(resolveStateDir(env), "__locks");
}

async function makeEnv() {
  const dir = await fixtureRootTracker.make("case");
  const configPath = path.join(dir, "openclaw.json");
  await fs.writeFile(configPath, "{}", "utf8");
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: dir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

async function acquireForTest(
  env: NodeJS.ProcessEnv,
  opts: Omit<GatewayLockOptions, "env" | "allowInTests"> = {},
) {
  return await acquireGatewayLock({
    env,
    allowInTests: true,
    timeoutMs: 30,
    pollIntervalMs: 2,
    now: realNow,
    sleep: async (ms) => {
      await nativeSleep(ms);
    },
    lockDir: resolveTestLockDir(env),
    ...opts,
  });
}

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>): GatewayLock {
  if (lock === null) {
    throw new Error("Expected gateway lock");
  }
  expect(typeof lock.release).toBe("function");
  return lock;
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  const configHash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
  const lockDir = resolveTestLockDir(env);
  fsSync.mkdirSync(lockDir, { recursive: true });
  return {
    lockPath: path.join(lockDir, `gateway.${configHash}.lock`),
    configPath,
    stateLockPath: path.join(lockDir, "gateway.state.lock"),
  };
}

function createLockPayload(params: {
  configPath: string;
  startTime: number;
  createdAt?: string;
  port?: number;
  role?: "gateway" | "sqlite-maintenance";
}) {
  return {
    pid: process.pid,
    createdAt: params.createdAt ?? new Date().toISOString(),
    configPath: params.configPath,
    ...(params.port ? { port: params.port } : {}),
    ...(params.role ? { role: params.role } : {}),
    startTime: params.startTime,
  };
}

async function writeLockFile(
  env: NodeJS.ProcessEnv,
  params: { startTime: number; createdAt?: string } = { startTime: 111 },
) {
  const { lockPath, configPath } = resolveLockPath(env);
  const payload = createLockPayload({
    configPath,
    startTime: params.startTime,
    createdAt: params.createdAt,
  });
  await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");
  return { lockPath, configPath };
}

async function writeRecentLockFile(env: NodeJS.ProcessEnv, startTime = 111) {
  await writeLockFile(env, {
    startTime,
    createdAt: new Date().toISOString(),
  });
}

async function holdLifecycleCoordinator(signal: AbortSignal) {
  const stateDir = await fixtureRootTracker.make("lifecycle-handoff");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const coordinator = acquireGatewayStateOwner({ databasePath });
  lifecycleDatabases.add(databasePath);
  coordinator.release();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { acquireFileLockSync } from "@openclaw/fs-safe/file-lock";
       const pathname = process.argv[1];
       const lock = acquireFileLockSync(pathname, {
         lockPath: pathname, retry: { retries: 0 },
         payload: () => ({ pid: process.pid, createdAt: new Date().toISOString(), configPath: "synthetic", role: "gateway" }),
       });
       process.on("message", () => {
         lock.release(); process.disconnect();
       });
       process.send("held");`,
      coordinator.path,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  const closed = once(child, "close");
  lifecycleChildren.set(child, closed);
  await withinTest(
    awaitGateBeforeSettlement(once(child, "message"), closed, "coordinator fixture did not start"),
    signal,
  );
  return {
    child,
    options: { env, allowInTests: true, lockDir: path.join(stateDir, "__locks") },
  };
}

async function withMaintenanceLock(
  run: (lock: GatewayLock, contender: () => ReturnType<typeof acquireGatewayLock>) => Promise<void>,
) {
  const env = await makeEnv();
  const lock = expectGatewayLock(
    await acquireForTest(env, { role: "sqlite-maintenance", timeoutMs: 0 }),
  );
  try {
    await run(lock, () => acquireForTest(env, { timeoutMs: 0 }));
  } finally {
    await lock.release();
  }
}

describe("gateway lock", () => {
  beforeAll(async () => {
    await fixtureRootTracker.setup();
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await fixtureRootTracker.cleanup();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const child of lifecycleChildren.keys()) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    await Promise.all(lifecycleChildren.values());
    lifecycleChildren.clear();
    for (const databasePath of lifecycleDatabases) {
      acquireGatewayStateOwner({ databasePath }).release();
    }
    lifecycleDatabases.clear();
  });

  it.each(["agent-embedded", "skill-workshop-apply"] as const)(
    "keeps an unclassified legacy %s owner unknown when start identity is unavailable",
    async (role) => {
      await expect(
        resolveGatewayOwnerStatus(
          process.pid,
          {
            pid: process.pid,
            createdAt: "2000-01-01T00:00:00.000Z",
            configPath: "/fixture/openclaw.json",
            role,
          },
          "linux",
          () => ["node", "dist/index.js", "gateway"],
          () => null,
        ),
      ).resolves.toBe("unknown");
    },
  );

  it.skipIf(process.platform === "win32")(
    "canonicalizes state-directory aliases before choosing the ownership lock",
    async () => {
      const stateDir = await fixtureRootTracker.make("canonical-state");
      const aliasRoot = await fixtureRootTracker.make("canonical-alias");
      const stateAlias = path.join(aliasRoot, "state-link");
      const configA = path.join(stateDir, "gateway-a.json");
      const configB = path.join(aliasRoot, "gateway-b.json");
      await fs.writeFile(configA, "{}", "utf8");
      await fs.writeFile(configB, "{}", "utf8");
      await fs.symlink(stateDir, stateAlias);
      const envA = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configA,
        OPENCLAW_STATE_DIR: stateDir,
      };
      const envB = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configB,
        OPENCLAW_STATE_DIR: stateAlias,
      };
      const lock = expectGatewayLock(await acquireForTest(envA, { platform: "darwin" }));

      try {
        await expect(
          acquireForTest(envB, {
            platform: "darwin",
            readProcessCmdline: () => ["openclaw-gateway"],
            timeoutMs: 15,
          }),
        ).rejects.toBeInstanceOf(GatewayLockError);
      } finally {
        await lock.release();
      }
    },
  );

  it("assigns a new verified owner identity whenever the gateway lock is reacquired", async () => {
    const env = await makeEnv();
    const options = {
      platform: "darwin" as const,
      port: 48789,
      readProcessCmdline: () => ["openclaw-gateway"],
    };
    const firstLock = expectGatewayLock(await acquireForTest(env, options));
    const firstConfigPayload = JSON.parse(await fs.readFile(firstLock.lockPath, "utf8")) as {
      ownerId?: string;
      cronOwnerProjection?: string;
      processNamespace?: unknown;
    };
    const firstStatePayload = JSON.parse(await fs.readFile(firstLock.stateLockPath, "utf8")) as {
      ownerId?: string;
      cronOwnerProjection?: string;
      processNamespace?: unknown;
    };
    const firstIdentity = await readActiveGatewayLockIdentity({
      env,
      lockDir: resolveTestLockDir(env),
      platform: "darwin",
      readProcessCmdline: options.readProcessCmdline,
    });
    expect(firstConfigPayload.ownerId).toBe(firstStatePayload.ownerId);
    expect(firstConfigPayload.cronOwnerProjection).toBe("dynamic-default-v1");
    expect(firstStatePayload.cronOwnerProjection).toBe("dynamic-default-v1");
    for (const payload of [firstConfigPayload, firstStatePayload]) {
      expect(payload.processNamespace).toEqual({
        host: os.hostname(),
        platform: process.platform,
        identity: expect.any(String),
        ...(process.platform === "linux"
          ? { pidNsInode: fsSync.statSync("/proc/self/ns/pid", { bigint: true }).ino.toString() }
          : {}),
      });
    }
    await firstLock.release();

    const secondLock = expectGatewayLock(await acquireForTest(env, options));
    try {
      const secondIdentity = await readActiveGatewayLockIdentity({
        env,
        lockDir: resolveTestLockDir(env),
        platform: "darwin",
        readProcessCmdline: options.readProcessCmdline,
      });
      expect(firstIdentity).toMatchObject({
        pid: process.pid,
        ownerId: expect.any(String),
        cronOwnerProjection: "dynamic-default-v1",
        port: 48789,
      });
      expect(secondIdentity).toMatchObject({
        pid: process.pid,
        ownerId: expect.any(String),
        cronOwnerProjection: "dynamic-default-v1",
        port: 48789,
      });
      expect(secondIdentity?.ownerId).not.toBe(firstIdentity?.ownerId);
      await expect(
        readActiveGatewayLockPort({ env, lockDir: resolveTestLockDir(env), ...options }),
      ).resolves.toBe(48789);
    } finally {
      await secondLock.release();
    }
  });

  it.each([
    { state: "missing port", file: "config" },
    { state: "corrupt", file: "state" },
    { state: "unreadable", file: "state" },
    { state: "unknown owner", file: "state" },
  ])(
    "preserves strict lock inspection for $state $file locks without changing discovery",
    async ({ state, file }) => {
      const env = await makeEnv();
      const { lockPath, stateLockPath, configPath } = resolveLockPath(env);
      const target = file === "state" ? stateLockPath : lockPath;
      const payload = createLockPayload({
        configPath,
        startTime: 111,
        ...(state !== "missing port" ? { port: 48789 } : {}),
      });
      await fs.writeFile(target, state === "corrupt" ? "{" : JSON.stringify(payload));
      if (state === "unreadable") {
        const readFile = fs.readFile;
        vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
          if (filePath === target) {
            throw Object.assign(new Error("permission denied"), { code: "EACCES" });
          }
          return readFile(filePath, options);
        });
      }
      const options = {
        env,
        lockDir: resolveTestLockDir(env),
        platform: "linux" as const,
        readProcessStartTime: () => null,
        readProcessCmdline: () => (state === "unknown owner" ? null : ["openclaw-gateway"]),
      };
      await expect(readActiveGatewayLockPort(options)).resolves.toBeUndefined();
      await expect(
        readActiveGatewayLockIdentity({ ...options, requireInspection: true }),
      ).rejects.toBeInstanceOf(GatewayLockError);
      const custody = readActiveGatewayLockIdentity({
        ...options,
        includeEmbedded: true,
        requireInspection: true,
      });
      if (state === "missing port") {
        await expect(custody).resolves.toMatchObject({ pid: process.pid });
      } else {
        await expect(custody).rejects.toBeInstanceOf(GatewayLockError);
      }
    },
  );

  it("serializes concurrent stale-lock reclamation", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { configPath, stateLockPath } = resolveLockPath(env);
    await fs.mkdir(path.dirname(stateLockPath), { recursive: true });
    await fs.writeFile(
      stateLockPath,
      JSON.stringify(createLockPayload({ configPath, startTime: 111 })),
      "utf8",
    );

    const attempts = await Promise.allSettled([
      acquireForTest(env, {
        platform: "linux",
        readProcessStartTime: () => 222,
        timeoutMs: 80,
      }),
      acquireForTest(env, {
        platform: "linux",
        readProcessStartTime: () => 222,
        timeoutMs: 25,
      }),
    ]);
    const acquired = attempts.filter(
      (result): result is PromiseFulfilledResult<GatewayLock> =>
        result.status === "fulfilled" && result.value !== null,
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(GatewayLockError);
    await fs.access(stateLockPath);

    const acquiredResult = acquired[0];
    if (!acquiredResult) {
      throw new Error("Expected one successful stale-lock contender");
    }
    await acquiredResult.value.release();
    const nextLock = expectGatewayLock(await acquireForTest(env));
    await nextLock.release();
  });

  it("preserves a fresh gateway lock that replaces the stale reclaim candidate", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { configPath, stateLockPath } = resolveLockPath(env);
    await fs.mkdir(path.dirname(stateLockPath), { recursive: true });
    await fs.writeFile(
      stateLockPath,
      JSON.stringify(createLockPayload({ configPath, startTime: 111 })),
      "utf8",
    );
    const replacement = {
      ...createLockPayload({ configPath, startTime: 333 }),
      ownerId: "replacement-owner",
    };
    let startTimeReads = 0;

    await expect(
      acquireForTest(env, {
        platform: "linux",
        timeoutMs: 25,
        readProcessStartTime: () => {
          startTimeReads += 1;
          if (startTimeReads === 2) {
            fsSync.writeFileSync(stateLockPath, JSON.stringify(replacement), "utf8");
          }
          return startTimeReads >= 3 ? 333 : 222;
        },
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(JSON.parse(await fs.readFile(stateLockPath, "utf8"))).toMatchObject(replacement);
  });

  it("keeps a verified maintenance owner when process start identity is unavailable", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );

    await expect(
      acquireForTest(env, {
        timeoutMs: 15,
        staleMs: 0,
        platform: "linux",
        readProcessStartTime: () => null,
        readProcessCmdline: () => [
          "node",
          "/srv/openclaw/openclaw.mjs",
          "doctor",
          "--state-sqlite",
          "compact",
        ],
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);
  });

  it("keeps an old maintenance owner when its live identity is unreadable", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath, configPath } = resolveLockPath(env);
    await fs.writeFile(
      lockPath,
      JSON.stringify(
        createLockPayload({
          configPath,
          createdAt: "2000-01-01T00:00:00.000Z",
          role: "sqlite-maintenance",
          startTime: 111,
        }),
      ),
      "utf8",
    );

    await expect(
      acquireForTest(env, {
        platform: "linux",
        readProcessStartTime: () => null,
        readProcessCmdline: () => null,
        staleMs: 0,
        timeoutMs: 80,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);
  });

  it("preserves historical ownership when filesystem identity inspection fails", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const { lockPath } = await writeLockFile(env);
    const original = await fs.readFile(lockPath, "utf8");
    const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    });

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      staleMs: 10_000,
      platform: "linux",
      readProcessStartTime: () => null,
      readProcessCmdline: () => null,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);

    statSpy.mockRestore();
    await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(original);
  });

  it("reclaims a lock when its live pid belongs to a non-gateway process", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    const script = path.join(env.OPENCLAW_STATE_DIR, "worker.js");
    await fs.writeFile(script, "");
    await writeRecentLockFile(env);

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "darwin",
      port: 18789,
      readProcessCmdline: () => ["node", script],
    });
    await expectGatewayLock(lock).release();
  });

  it("bounds oversized lock polling intervals by the acquire timeout", async () => {
    const env = await makeEnv();
    await writeRecentLockFile(env);
    const sleepDelays: number[] = [];
    let now = 0;

    await expect(
      acquireGatewayLock({
        env,
        allowInTests: true,
        timeoutMs: 5,
        pollIntervalMs: Number.MAX_SAFE_INTEGER,
        staleMs: 10_000,
        platform: "darwin",
        now: () => now,
        sleep: async (ms) => {
          sleepDelays.push(ms);
          now = 10;
        },
        lockDir: resolveTestLockDir(env),
        readProcessCmdline: () => ["/usr/local/bin/openclaw", "gateway", "run"],
        readProcessStartTime: () => 111,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(sleepDelays).toEqual([5]);
  });

  it("keeps state ownership when the config singleton override is enabled", async () => {
    const env = await makeEnv();
    const { lockPath, stateLockPath } = resolveLockPath(env);
    const lock = expectGatewayLock(
      await acquireGatewayLock({
        allowInTests: true,
        env: { ...env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1", VITEST: "" },
        lockDir: resolveTestLockDir(env),
      }),
    );

    try {
      expect(lock.stateLockPath).toBe(stateLockPath);
      expect(lock.lockPath).not.toBe(stateLockPath);
      await fs.access(stateLockPath);
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir: resolveTestLockDir(env),
          platform: "darwin",
          readProcessCmdline: () => ["openclaw-gateway"],
          timeoutMs: 15,
        }),
      ).rejects.toBeInstanceOf(GatewayLockError);
    } finally {
      await lock.release();
    }
  });

  it("returns null in test env unless allowInTests is set", async () => {
    const env = await makeEnv();
    const lock = await acquireGatewayLock({
      env: { ...env, VITEST: "1" },
      lockDir: resolveTestLockDir(env),
    });
    expect(lock).toBeNull();
  });

  it("wraps unexpected fs errors as GatewayLockError", async () => {
    const env = await makeEnv();
    const openSpy = vi.spyOn(fsSync, "openSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), {
        code: "EACCES",
      });
    });

    await expect(acquireForTest(env)).rejects.toBeInstanceOf(GatewayLockError);
    openSpy.mockRestore();
  });

  it("clears stale lock on win32 when process cmdline is not a gateway", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const lock = await acquireForTest(env, {
      timeoutMs: 80,
      pollIntervalMs: 5,
      staleMs: 10_000,
      platform: "win32",
      port: 18789,
      readProcessCmdline: () => ["chrome.exe", "--no-sandbox"],
      readProcessStartTime: () => null,
    });
    await expectGatewayLock(lock).release();
  });

  it("falls back to unknown on win32 when cmdline reader returns null", async () => {
    vi.useRealTimers();
    const env = await makeEnv();
    await writeRecentLockFile(env);

    const pending = acquireForTest(env, {
      timeoutMs: 20,
      pollIntervalMs: 2,
      staleMs: 10_000,
      platform: "win32",
      port: 18789,
      readProcessCmdline: () => null,
      readProcessStartTime: () => null,
    });
    await expect(pending).rejects.toBeInstanceOf(GatewayLockError);
  });

  it("acquires when the predecessor releases during the startup wait", async ({ signal }) => {
    const { child, options } = await holdLifecycleCoordinator(signal);
    const lock = await acquireGatewayLock({
      ...options,
      sleep: async () => {
        child.send("release");
        await lifecycleChildren.get(child);
      },
    });
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it("bounds a live owner's wait at five minutes and names state ownership", async ({ signal }) => {
    const { options } = await holdLifecycleCoordinator(signal);
    let elapsedMs = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsedMs += ms;
    });
    await expect(acquireGatewayLock({ ...options, now: () => elapsedMs, sleep })).rejects.toThrow(
      "failed to acquire gateway state ownership; waited 300000ms for Gateway state ownership",
    );
    expect(elapsedMs).toBe(300_000);
    expect(sleep).toHaveBeenCalled();
  });

  it("observes embedded custody only when requested", async () => {
    const env = await makeEnv();
    const lockDir = resolveTestLockDir(env);
    const port = 28789;
    const readProcessCmdline = () => ["openclaw", "agent", "--local", "--message", "hello"];
    const lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      lockDir,
      platform: "darwin",
      port,
      readProcessCmdline,
      readProcessStartTime: () => null,
      role: "agent-embedded",
      timeoutMs: 30,
    });
    expect(lock).not.toBeNull();
    if (!lock) {
      throw new Error("Expected embedded agent Gateway lock");
    }

    try {
      await expect(
        readActiveGatewayLockIdentity({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline,
          readProcessStartTime: () => null,
        }),
      ).resolves.toBeUndefined();
      await expect(
        readActiveGatewayLockIdentity({
          env,
          lockDir,
          platform: "darwin",
          readProcessCmdline,
          readProcessStartTime: () => null,
          includeEmbedded: true,
          requireInspection: true,
        }),
      ).resolves.toMatchObject({ pid: process.pid, port });
      await expect(
        acquireGatewayLock({
          allowInTests: true,
          env,
          lockDir,
          platform: "darwin",
          pollIntervalMs: 2,
          readProcessCmdline,
          readProcessStartTime: () => null,
          sleep: nativeSleep,
          timeoutMs: 15,
        }),
      ).rejects.toThrow("failed to acquire gateway state ownership");
    } finally {
      await lock.release();
    }
  });

  it("keeps startup excluded while concurrent releases join resource drainage", async () => {
    await withMaintenanceLock(async (lock, contender) => {
      const started = createDeferred();
      const drained = createDeferred();
      const close = vi.fn(async () => {
        started.resolve();
        await drained.promise;
      });
      lock.run(() => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        expect(scope?.ownsSchemaMaintenance).toBe(true);
        scope?.own({}, "shared-resources", close);
      });
      const releases = [lock.release(), lock.releaseInTree(), lock.release()];
      try {
        await started.promise;
        await expect(contender()).rejects.toBeInstanceOf(GatewayLockError);
        await fs.access(lock.lockPath);
        await fs.access(lock.stateLockPath);
      } finally {
        drained.resolve();
        await Promise.all(releases);
      }
      expect(close).toHaveBeenCalledTimes(1);
      await Promise.all([lock.release(), lock.releaseInTree()]);
      expect(close).toHaveBeenCalledTimes(1);
      await expect(fs.access(lock.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(lock.stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await (await contender())?.release();
    });
  });

  it("retains the process owner after failed drainage and retries only unsettled resources", async () => {
    await withMaintenanceLock(async (lock, contender) => {
      const failure = new Error("Controlled cleanup failure");
      const closeAgent = vi.fn();
      const closeShared = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
      lock.run(() => {
        const scope = getOpenClawDatabaseMaintenanceScope();
        scope?.own({}, "agent-resources", closeAgent);
        scope?.own({}, "shared-resources", closeShared);
      });
      const results = await Promise.allSettled([lock.release(), lock.release()]);
      expect(results).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      await expect(contender()).rejects.toBeInstanceOf(GatewayLockError);
      await fs.access(lock.lockPath);
      await fs.access(lock.stateLockPath);
      await lock.release();
      expect(closeAgent).toHaveBeenCalledTimes(1);
      expect(closeShared).toHaveBeenCalledTimes(2);
      await (await contender())?.release();
    });
  });

  it("releases in-tree locks separately from Gateway lifecycle ownership", async () => {
    const lock = expectGatewayLock(await acquireForTest(await makeEnv()));
    try {
      await lock.releaseInTree();
      await fs.access(lock.lockPath);
      await expect(fs.access(lock.stateLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await lock.release();
    }
  });
});
