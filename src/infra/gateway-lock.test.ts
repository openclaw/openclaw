import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { resolveStateDir } from "../config/paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import * as gatewayLockProcessModule from "./gateway-lock-process.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  readActiveGatewayLockIdentity,
  readActiveGatewayLockPort,
  resolveGatewayLockPaths,
} from "./gateway-lock.js";
import { acquireGatewayStateOwner, captureGatewayStateOwner } from "./gateway-state-owner.js";

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
    sleep: nativeSleep,
    lockDir: resolveTestLockDir(env),
    ...opts,
  });
}

function expectGatewayLock(lock: Awaited<ReturnType<typeof acquireGatewayLock>>): GatewayLock {
  if (lock === null) {
    throw new Error("Expected gateway lock");
  }
  return lock;
}

function resolveLockPath(env: NodeJS.ProcessEnv) {
  const lockDir = resolveTestLockDir(env);
  fsSync.mkdirSync(lockDir, { recursive: true });
  const paths = resolveGatewayLockPaths(env, lockDir);
  return { ...paths, lockPath: paths.configLockPath };
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
    processNamespace: readGatewayLockProcessNamespace(),
  };
}

async function writeLockFile(
  env: NodeJS.ProcessEnv,
  params: Partial<Omit<Parameters<typeof createLockPayload>[0], "configPath">> = {},
  state = false,
) {
  const paths = resolveLockPath(env);
  const payload = createLockPayload({ configPath: paths.configPath, startTime: 111, ...params });
  await fs.writeFile(state ? paths.stateLockPath : paths.lockPath, JSON.stringify(payload), "utf8");
  return paths;
}

function expectContention(env: NodeJS.ProcessEnv, options: Omit<GatewayLockOptions, "env">) {
  return expect(acquireForTest(env, options)).rejects.toBeInstanceOf(GatewayLockError);
}

function observation(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "darwin") {
  return { env, lockDir: resolveTestLockDir(env), platform };
}

async function withLock(
  env: NodeJS.ProcessEnv,
  options: Omit<GatewayLockOptions, "env">,
  run: (lock: GatewayLock) => Promise<void>,
) {
  const lock = expectGatewayLock(await acquireForTest(env, options));
  try {
    await run(lock);
  } finally {
    await lock.release();
  }
}

function mockProcessIdentity(cmdline: string[] | null, startTime: number | null = null) {
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessCmdline").mockReturnValue(cmdline);
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockReturnValue(startTime);
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
         payload: () => ({ pid: process.pid, createdAt: new Date().toISOString(), configPath: "synthetic", role: "gateway", processNamespace: ${JSON.stringify(readGatewayLockProcessNamespace())} }),
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
  await withLock(env, { role: "sqlite-maintenance", timeoutMs: 0 }, (lock) =>
    run(lock, () => acquireForTest(env, { timeoutMs: 0 })),
  );
}

beforeAll(() => fixtureRootTracker.setup());

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(() => fixtureRootTracker.cleanup());

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

it.each(["root", "projection"])(
  "refuses corrupt foreign %s payloads and detects changes to held custody",
  async (kind) => {
    const env = await makeEnv();
    const databasePath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const seed = expectGatewayLock(await acquireForTest(env));
    const pathname = kind === "root" ? seed.lockPath : seed.stateLockPath;
    const record = JSON.parse(await fs.readFile(pathname, "utf8"));
    await seed.release();
    // A dead PID alone must not authorize reclamation of a malformed record.
    const corrupt = JSON.stringify({ ...record, pid: 2_147_483_647, createdAt: 42 });
    await fs.writeFile(pathname, corrupt);
    await expect(acquireForTest(env, { timeoutMs: 0 })).rejects.toThrow();
    expect(await fs.readFile(pathname, "utf8")).toBe(corrupt);
    await fs.unlink(pathname);

    await withLock(env, {}, async (owner) => {
      owner.run(() => {
        const captured = captureGatewayStateOwner(databasePath);
        expect(captured).toBeDefined();
        captured!.assertCurrent();
        // Preserve the acquisition token: exact payload bytes still bind custody.
        const held = fsSync.readFileSync(pathname, "utf8");
        fsSync.writeFileSync(pathname, held.replace(/"createdAt":\s*"[^"]*"/u, '"createdAt":42'));
        expect(() => captured!.assertCurrent()).toThrow();
        expect(() => owner.assertCurrent()).toThrow();
      });
    });
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
    const envA = { ...process.env, OPENCLAW_CONFIG_PATH: configA, OPENCLAW_STATE_DIR: stateDir };
    const envB = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configB,
      OPENCLAW_STATE_DIR: stateAlias,
    };
    await withLock(envA, { platform: "darwin" }, async () => {
      vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessCmdline").mockReturnValue([
        "openclaw-gateway",
      ]);
      await expectContention(envB, { platform: "darwin", timeoutMs: 15 });
    });
  },
);

it("reacquires with a new identity and matching discovery projections", async () => {
  const env = await makeEnv();
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessCmdline").mockReturnValue([
    "openclaw-gateway",
  ]);
  const options = observation(env);
  const firstLock = expectGatewayLock(await acquireForTest(env, { ...options, port: 48789 }));
  const first = await readActiveGatewayLockIdentity(options);
  for (const pathname of [firstLock.lockPath, firstLock.stateLockPath]) {
    const payload = JSON.parse(await fs.readFile(pathname, "utf8"));
    expect(payload).toMatchObject({
      ownerId: first?.ownerId,
      cronOwnerProjection: "dynamic-default-v1",
    });
  }
  await firstLock.release();
  await withLock(env, { ...options, port: 48789 }, async () => {
    const second = await readActiveGatewayLockIdentity(options);
    for (const identity of [first, second]) {
      expect(identity).toMatchObject({
        pid: process.pid,
        ownerId: expect.any(String),
        cronOwnerProjection: "dynamic-default-v1",
        port: 48789,
      });
    }
    expect(second?.ownerId).not.toBe(first?.ownerId);
    await expect(readActiveGatewayLockPort(options)).resolves.toBe(48789);
  });
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
    mockProcessIdentity(state === "unknown owner" ? null : ["openclaw-gateway"]);
    const options = observation(env, "linux");
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
  const env = await makeEnv();
  const { stateLockPath } = await writeLockFile(env, {}, true);

  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockReturnValue(222);
  const attempts = await Promise.allSettled(
    [80, 25].map((timeoutMs) => acquireForTest(env, { platform: "linux", timeoutMs })),
  );
  expect(attempts).toEqual(
    expect.arrayContaining([
      { status: "fulfilled", value: expect.any(Object) },
      { status: "rejected", reason: expect.any(GatewayLockError) },
    ]),
  );
  await fs.access(stateLockPath);
  for (const result of attempts) {
    if (result.status === "fulfilled") {
      await expectGatewayLock(result.value).release();
    }
  }
  const nextLock = expectGatewayLock(await acquireForTest(env));
  await nextLock.release();
});

it("preserves a fresh gateway lock that replaces the stale reclaim candidate", async () => {
  const env = await makeEnv();
  const { configPath, stateLockPath } = await writeLockFile(env, {}, true);
  const replacement = {
    ...createLockPayload({ configPath, startTime: 333 }),
    ownerId: "replacement-owner",
  };
  let startTimeReads = 0;

  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockImplementation(() => {
    startTimeReads += 1;
    if (startTimeReads === 2) {
      fsSync.writeFileSync(stateLockPath, JSON.stringify(replacement), "utf8");
    }
    return startTimeReads >= 3 ? 333 : 222;
  });
  await expectContention(env, { platform: "linux", timeoutMs: 25 });

  expect(JSON.parse(await fs.readFile(stateLockPath, "utf8"))).toMatchObject(replacement);
});

it.each([
  {
    label: "doctor",
    cmdline: ["node", "/srv/openclaw/openclaw.mjs", "doctor", "--state-sqlite", "compact"],
  },
  {
    label: "sessions",
    cmdline: ["node", "/srv/openclaw/openclaw.mjs", "sessions", "cleanup", "--enforce"],
  },
  { label: "unreadable", cmdline: null },
])("keeps an old maintenance owner with $label identity", async ({ cmdline }) => {
  const env = await makeEnv();
  await writeLockFile(env, {
    createdAt: "2000-01-01T00:00:00.000Z",
    role: "sqlite-maintenance",
  });
  mockProcessIdentity(cmdline);
  await expectContention(env, { timeoutMs: cmdline ? 15 : 80, platform: "linux" });
});

it("preserves historical ownership when filesystem identity inspection fails", async () => {
  const env = await makeEnv();
  const { lockPath } = await writeLockFile(env);
  const original = await fs.readFile(lockPath, "utf8");
  const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation(() => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  });

  mockProcessIdentity(null);
  await expectContention(env, { timeoutMs: 20, platform: "linux" });

  statSpy.mockRestore();
  await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(original);
});

it("bounds oversized lock polling intervals by the acquire timeout", async () => {
  const env = await makeEnv();
  await writeLockFile(env);
  const sleepDelays: number[] = [];
  let now = 0;

  mockProcessIdentity(["/usr/local/bin/openclaw", "gateway", "run"], 111);
  await expect(
    acquireForTest(env, {
      timeoutMs: 5,
      pollIntervalMs: Number.MAX_SAFE_INTEGER,
      platform: "darwin",
      now: () => now,
      sleep: async (ms) => {
        sleepDelays.push(ms);
        now = 10;
      },
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
    vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessCmdline").mockReturnValue([
      "openclaw-gateway",
    ]);
    await expect(
      acquireGatewayLock({
        allowInTests: true,
        env,
        lockDir: resolveTestLockDir(env),
        platform: "darwin",
        timeoutMs: 15,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);
  } finally {
    await lock.release();
  }
});

it("returns null in test env unless allowInTests is set", async () => {
  const env = await makeEnv();
  const lock = await acquireGatewayLock(observation({ ...env, VITEST: "1" }));
  expect(lock).toBeNull();
});

it.each([
  { platform: "darwin", cmdline: ["node", "worker.js"] },
  { platform: "win32", cmdline: null },
] satisfies { platform: NodeJS.Platform; cmdline: string[] | null }[])(
  "preserves live $platform custody with cmdline $cmdline",
  async ({ platform, cmdline }) => {
    const env = await makeEnv();
    let observedCmdline = cmdline;
    if (platform === "darwin") {
      const script = path.join(env.OPENCLAW_STATE_DIR, "worker.js");
      await fs.writeFile(script, "");
      observedCmdline = ["node", script];
    }
    await writeLockFile(env);
    mockProcessIdentity(observedCmdline);
    await expectContention(env, {
      timeoutMs: cmdline ? 80 : 20,
      pollIntervalMs: cmdline ? 5 : 2,
      platform,
      port: 18789,
    });
  },
);

it("acquires promptly when the predecessor releases during a prolonged startup wait", async ({
  signal,
}) => {
  const { child, options } = await holdLifecycleCoordinator(signal);
  const releasedAtMs = 5_001;
  let elapsedMs = 0;
  const lock = await acquireGatewayLock({
    ...options,
    now: () => elapsedMs,
    sleep: async (ms) => {
      elapsedMs += ms;
      if (elapsedMs >= releasedAtMs) {
        child.send("release");
        await lifecycleChildren.get(child);
      }
    },
  });
  try {
    expect(lock).not.toBeNull();
    expect(elapsedMs - releasedAtMs).toBeLessThanOrEqual(250);
  } finally {
    await lock?.release();
  }
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
  const options = observation(env);
  const port = 28789;
  mockProcessIdentity(["openclaw", "agent", "--local", "--message", "hello"]);
  await withLock(
    env,
    {
      platform: "darwin",
      port,
      role: "agent-embedded",
      timeoutMs: 30,
    },
    async () => {
      await expect(readActiveGatewayLockIdentity(options)).resolves.toBeUndefined();
      await expect(
        readActiveGatewayLockIdentity({
          ...options,
          includeEmbedded: true,
          requireInspection: true,
        }),
      ).resolves.toMatchObject({ pid: process.pid, port });
      await expect(
        acquireForTest(env, {
          platform: "darwin",
          pollIntervalMs: 2,
          sleep: nativeSleep,
          timeoutMs: 15,
        }),
      ).rejects.toThrow("failed to acquire gateway state ownership");
    },
  );
});

it("keeps startup excluded while concurrent releases join resource drainage", async () => {
  await withMaintenanceLock(async (lock, contender) => {
    const drainageGate = createEnteredGate();
    const close = vi.fn(drainageGate.wait);
    lock.run(() => {
      const scope = getOpenClawDatabaseMaintenanceScope();
      expect(scope?.ownsSchemaMaintenance).toBe(true);
      scope?.own({}, "shared-resources", close);
    });
    const releases = [lock.release(), lock.release(), lock.release()];
    try {
      await drainageGate.entered;
      await expect(contender()).rejects.toBeInstanceOf(GatewayLockError);
      await fs.access(lock.lockPath);
      await fs.access(lock.stateLockPath);
    } finally {
      drainageGate.release();
      await Promise.all(releases);
    }
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.all([lock.release(), lock.release()]);
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
