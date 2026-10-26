import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireDoctorGatewayMaintenanceOwner } from "../commands/doctor-maintenance-foreground.js";
import { resolveStateDir } from "../config/paths.js";
import * as processIdentity from "../shared/pid-alive.js";
import * as machineIdentity from "./current-machine-identity.js";
import { mockLinuxNamespace } from "./gateway-lock-namespace.test-support.js";
import {
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  parseGatewayLockPayload,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import * as gatewayLockProcessModule from "./gateway-lock-process.js";
import { shippedLockPayloadSchema } from "./gateway-lock-rollback.test-support.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  readActiveGatewayLockIdentity,
  resolveGatewayLockPaths,
  resolveGatewayOwnerStatus,
} from "./gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
  GatewayStateOwnerContentionError,
  resolveGatewayStateOwnerPath,
} from "./gateway-state-owner.js";
import * as bootReader from "./update-managed-service-handoff-boot.js";

// SQLite preload imports the machine owner before this file installs its native probe mock.
vi.hoisted(() => vi.resetModules());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
}));

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
    processNamespace: readGatewayLockProcessNamespace(),
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

  it.each(["discovered", "unavailable", "inherited"] as const)(
    "observes the Darwin machine once and carries its %s fact",
    (kind) => {
      const key = machineIdentity.PROCESS_MACHINE_IDENTITY_KEY;
      const previous = getEnvironmentData(key);
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      setEnvironmentData(
        key,
        kind === "inherited" ? { platform: "darwin", value: "a".repeat(64) } : undefined,
      );
      const probe = vi
        .mocked(spawnSync)
        .mockClear()
        .mockImplementationOnce(() => {
          throw new Error("machine observation unavailable");
        });
      if (kind === "discovered") {
        probe.mockReset().mockReturnValueOnce({
          pid: 1,
          output: [null, '"IOPlatformUUID" = "12345678-abcd-1234-abcd-123456789abc"', null],
          stdout: '"IOPlatformUUID" = "12345678-abcd-1234-abcd-123456789abc"',
          stderr: "",
          status: 0,
          signal: null,
        });
      }
      try {
        const observed = machineIdentity.readProcessMachineIdentity();
        expect(observed).toEqual(
          kind === "unavailable" ? null : expect.stringMatching(/^[a-f0-9]{64}$/u),
        );
        expect(machineIdentity.readProcessMachineIdentity()).toBe(observed);
        expect(probe).toHaveBeenCalledTimes(kind === "inherited" ? 0 : 1);
        expect(getEnvironmentData(key)).toEqual({ platform: "darwin", value: observed });
      } finally {
        probe.mockReset();
        setEnvironmentData(key, previous);
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "writes machine evidence outside the frozen shipped namespace in every lock projection",
    async () => {
      vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue("a".repeat(64));
      const env = await makeEnv();
      const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
      const acquired = await acquireForTest(env);
      try {
        expect(acquired).not.toBeNull();
        for (const file of [paths.ownerLockPath, paths.stateLockPath]) {
          const record = JSON.parse(await fs.readFile(file, "utf8"));
          expect(record.machineIdentity).toBe(
            process.platform === "darwin" ? "a".repeat(64) : undefined,
          );
          const oldReader = shippedLockPayloadSchema.parse(record);
          expect(oldReader.processNamespace).toEqual(record.processNamespace);
          expect(oldReader).not.toHaveProperty("machineIdentity");
          expect(oldReader.pid).toBe(process.pid);
        }
      } finally {
        await acquired?.release();
      }
    },
  );

  it.each([
    {
      kind: "unavailable owner",
      machine: null,
      localMachine: "a".repeat(64),
      sameHost: true,
      state: "dead",
    },
    {
      kind: "unavailable local",
      machine: "a".repeat(64),
      localMachine: null,
      sameHost: true,
      state: "dead",
    },
    {
      kind: "cloned",
      machine: "a".repeat(64),
      localMachine: "a".repeat(64),
      sameHost: false,
      state: "unknown",
    },
    {
      kind: "changed",
      machine: "b".repeat(64),
      localMachine: "a".repeat(64),
      sameHost: true,
      state: "dead",
    },
  ] as const)(
    "preserves Linux previous-boot classification with $kind machine evidence",
    async (row) => {
      const env = await makeEnv();
      const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
      vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue(row.localMachine);
      const payload = {
        ...createLockPayload({ configPath: env.OPENCLAW_CONFIG_PATH, startTime: 1 }),
        machineIdentity: row.machine,
        processNamespace: {
          ...namespace,
          host: row.sameHost ? namespace.host : "another-host",
          identity: "87654321-abcd-0123-abcd-0123456789ab",
          pidNsInode: "other-pid-namespace",
        },
      };
      await expect(resolveGatewayOwnerStatus(process.pid, payload, "linux")).resolves.toBe(
        row.state,
      );
    },
  );

  it("reads the Linux namespace identity without following its procfs magic link", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const boot = vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader");
    boot.mockReturnValue(() => ({
      platform: "darwin",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    readGatewayLockProcessNamespace();
    platform.mockReturnValue("linux");
    boot.mockReturnValue(() => ({
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    const readlink = fsSync.readlinkSync.bind(fsSync);
    vi.spyOn(fsSync, "readlinkSync").mockImplementation((file, options) =>
      file === "/proc/self/ns/pid" ? "pid:[4026532609]" : readlink(file, options),
    );
    const stat = fsSync.statSync.bind(fsSync);
    vi.spyOn(fsSync, "statSync").mockImplementation((file, options) => {
      if (file === "/proc/self/ns/pid") {
        throw Object.assign(new Error("Cannot follow the namespace magic link"), {
          code: "ENOENT",
        });
      }
      return stat(file, options);
    });
    expect(readGatewayLockProcessNamespace()).toEqual({
      host: os.hostname(),
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
      pidNsInode: "4026532609",
    });
  });

  it("uses native process identity for local Windows owners without a boot probe", async () => {
    const platform = "win32";
    const mockedPlatform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const boot = vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader");
    boot.mockReturnValue(() => ({
      platform: "darwin",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    readGatewayLockProcessNamespace();
    mockedPlatform.mockReturnValue(platform);
    boot.mockReturnValue(() => {
      throw new Error("Windows boot observation unavailable");
    });
    const namespace = readGatewayLockProcessNamespace();
    expect(namespace).toEqual({ host: os.hostname(), platform });
    for (const [processNamespace, comparable] of [
      [undefined, false],
      [null, false],
      [namespace, true],
      [{ ...namespace, identity: "2026-10-01T00:00:00.0000000Z" }, true],
      [{ ...namespace, host: "other-host" }, false],
      [{ ...namespace, host: "" }, false],
      [{ ...namespace, identity: "malformed" }, false],
      [
        {
          host: os.hostname(),
          platform: "linux",
          identity: "01234567-89ab-cdef-0123-456789abcdef",
          pidNsInode: "foreign",
        },
        false,
      ],
    ] as const) {
      const payload = parseGatewayLockPayload(
        JSON.stringify({
          ...createLockPayload({ configPath: "/unused", startTime: 123 }),
          processNamespace,
        }),
      );
      await expect(resolveGatewayOwnerStatus(2_147_483_647, payload, platform)).resolves.toBe(
        comparable ? "dead" : "unknown",
      );
      vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockImplementation(
        () => 123,
      );
      await expect(resolveGatewayOwnerStatus(process.pid, payload, platform)).resolves.toBe(
        comparable ? "alive" : "unknown",
      );
      vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessStartTime").mockImplementation(
        () => 124,
      );
      await expect(resolveGatewayOwnerStatus(process.pid, payload, platform)).resolves.toBe(
        comparable ? "dead" : "unknown",
      );
    }
  });

  it.each([
    { state: "live", startTime: 123, dead: false, reclaim: false },
    { state: "unreadable", startTime: null, dead: false, reclaim: false },
    { state: "reused", startTime: 124, dead: false, reclaim: true },
    { state: "exited", startTime: null, dead: true, reclaim: true },
  ])(
    "uses process identity for a $state Windows owner despite boot disagreement",
    ({ startTime, dead, reclaim }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-owner-boot-mismatch-") };
      const databasePath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
      vi.spyOn(os, "homedir").mockReturnValue(env.OPENCLAW_STATE_DIR);
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const boot = vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader");
      boot.mockReturnValue(() => ({
        platform: "darwin",
        identity: "01234567-89ab-cdef-0123-456789abcdef",
      }));
      // Discard the process-lifetime namespace cache from the preceding fixture.
      readGatewayLockProcessNamespace();
      platform.mockReturnValue("win32");
      boot.mockReturnValue(() => ({
        platform: "win32",
        identity: "2026-10-17T00:00:01.0000000Z",
      }));
      vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockReturnValue(startTime);
      vi.spyOn(processIdentity, "isPidDefinitelyDead").mockReturnValue(dead);
      vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(!dead);
      const ownerPath = resolveGatewayStateOwnerPath(databasePath);
      fsSync.mkdirSync(path.dirname(ownerPath), { recursive: true });
      const payload = {
        pid: 2_147_483_647,
        ownerId: "previous-owner",
        createdAt: "2026-10-17T00:00:00.000Z",
        configPath: path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
        startTime: 123,
        processNamespace: {
          host: os.hostname(),
          platform: "win32",
          identity: "2026-10-17T00:00:00.0000000Z",
        },
      };
      const record = JSON.stringify(payload);
      fsSync.writeFileSync(ownerPath, record);
      const expired = new Date(Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1000);
      fsSync.utimesSync(ownerPath, expired, expired);
      let acquired: ReturnType<typeof acquireGatewayStateOwner> | undefined;
      try {
        if (!reclaim) {
          expect(() => {
            acquired = acquireStateDatabaseSchemaLease(databasePath, { busyTimeoutMs: 0 });
          }).toThrow(GatewayStateOwnerContentionError);
          expect(fsSync.readFileSync(ownerPath, "utf8")).toBe(record);
        } else {
          acquired = acquireGatewayStateOwner({ databasePath });
          expect(JSON.parse(fsSync.readFileSync(ownerPath, "utf8")).ownerId).not.toBe(
            "previous-owner",
          );
        }
      } finally {
        acquired?.release();
        fsSync.rmSync(ownerPath, { force: true });
      }
    },
  );

  it.each(["unreadable", "malformed", "boot unavailable", "boot method mismatch"])(
    "preserves ownership regardless of heartbeat age when namespace observation is %s",
    async (failure) => {
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
        if (failure === "boot unavailable") {
          throw new Error("Boot identity unavailable");
        }
        return {
          platform: "linux",
          identity:
            failure === "boot method mismatch"
              ? "2026-10-17T00:00:00.0000000Z"
              : "01234567-89ab-cdef-0123-456789abcdef",
        };
      });
      const readlink = fsSync.readlinkSync.bind(fsSync);
      vi.spyOn(fsSync, "readlinkSync").mockImplementation((file, options) => {
        if (file === "/proc/self/ns/pid") {
          if (failure.startsWith("boot ")) {
            return "pid:[123]";
          }
          if (failure === "malformed") {
            return "pid:[not-an-inode]";
          }
          throw Object.assign(new Error("PID namespace unavailable"), { code: "EACCES" });
        }
        return readlink(file, options);
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
      await expect(acquireForTest(env, { role: "sqlite-maintenance" })).rejects.toThrow(
        "cannot verify Gateway ownership from this process",
      );
      await expect(fs.readFile(paths.ownerLockPath, "utf8")).resolves.toBe(record);
    },
  );

  it.each(["missing", "null", "malformed"])(
    "does not reclaim an expired owner with a %s namespace record",
    async (kind) => {
      const env = await makeEnv();
      const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
      const payload = {
        ...createLockPayload({ configPath: paths.configPath, startTime: 1 }),
        pid: 2_147_483_647,
        processNamespace:
          kind === "missing"
            ? undefined
            : kind === "null"
              ? null
              : { host: os.hostname(), platform: "linux", identity: "unavailable" },
      };
      const record = JSON.stringify(payload);
      await fs.mkdir(path.dirname(paths.ownerLockPath), { recursive: true });
      await fs.writeFile(paths.ownerLockPath, record);
      const expired = new Date(Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1000);
      await fs.utimes(paths.ownerLockPath, expired, expired);
      await expect(acquireForTest(env)).rejects.toThrow("openclaw gateway recover-lock");
      await expect(fs.readFile(paths.ownerLockPath, "utf8")).resolves.toBe(record);
    },
  );

  it.each([
    { owner: "exited", dead: true, startTime: null, stale: true, reclaim: true },
    { owner: "reused", dead: false, startTime: 124, stale: true, reclaim: true },
    { owner: "live", dead: false, startTime: 123, stale: true, reclaim: false },
    { owner: "unknown", dead: false, startTime: null, stale: true, reclaim: false },
    { owner: "recently exited", dead: true, startTime: null, stale: false, reclaim: false },
  ])("inspects and acquires a legacy Windows lock with a $owner owner", async (test) => {
    const env = await makeEnv();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(!test.dead);
    vi.spyOn(processIdentity, "isPidDefinitelyDead").mockReturnValue(test.dead);
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((pid) =>
      pid === process.pid ? 123 : test.startTime,
    );
    const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
    const record = JSON.stringify({
      pid: 2_147_483_647,
      role: "gateway",
      createdAt: "2026-09-01T00:00:00.000Z",
      configPath: paths.configPath,
      startTime: 123,
      port: 18789,
    });
    // Both historical projections and the state owner must agree before startup.
    for (const file of [paths.ownerLockPath, paths.stateLockPath, paths.configLockPath]) {
      fsSync.mkdirSync(path.dirname(file), { recursive: true });
      fsSync.writeFileSync(file, record);
      const stamp = new Date(
        Date.now() - (test.stale ? GATEWAY_OWNER_HEARTBEAT_STALE_MS + 1000 : 0),
      );
      fsSync.utimesSync(file, stamp, stamp);
    }
    if (!test.reclaim) {
      await expect(
        readActiveGatewayLockIdentity({
          env,
          lockDir: resolveTestLockDir(env),
          requireInspection: true,
        }),
      ).rejects.toThrow("openclaw gateway recover-lock");
      await expect(acquireForTest(env)).rejects.toThrow("openclaw gateway recover-lock");
      expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).toBe(record);
      return;
    }
    await expect(
      readActiveGatewayLockIdentity({
        env,
        lockDir: resolveTestLockDir(env),
        requireInspection: true,
      }),
    ).resolves.toBeUndefined();
    const acquired = await acquireForTest(env);
    try {
      expect(acquired).not.toBeNull();
      expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).not.toBe(record);
    } finally {
      await acquired?.release();
    }
  });

  it("recovers automatically after a verified boot change on the same non-Windows host", async () => {
    const env = await makeEnv();
    const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
    const databasePath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const ownerPath = resolveGatewayStateOwnerPath(databasePath);
    const record = JSON.stringify({
      ...createLockPayload({ configPath: env.OPENCLAW_CONFIG_PATH, startTime: 1 }),
      ownerId: "previous-boot-owner",
      processNamespace: {
        ...namespace,
        identity: namespace.identity.replace(/[0-9a-f]/i, (digit) => (digit === "1" ? "2" : "1")),
      },
    });
    await fs.mkdir(path.dirname(ownerPath), { recursive: true });
    await fs.writeFile(ownerPath, record);
    const owner = acquireStateDatabaseSchemaLease(databasePath, { busyTimeoutMs: 0 });
    try {
      owner.assertCurrent();
      expect(fsSync.readFileSync(ownerPath, "utf8")).not.toBe(record);
    } finally {
      owner.release();
    }
  });

  it.each(["crashed", "renewing"] as const)(
    "bounds startup waiting without reclaiming a %s foreign-namespace owner",
    async (kind) => {
      const env = await makeEnv();
      const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
      vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue("a".repeat(64));
      vi.useFakeTimers();
      const paths = resolveGatewayLockPaths(env, resolveTestLockDir(env));
      const payload = JSON.stringify({
        ...createLockPayload({ configPath: paths.configPath, startTime: 1 }),
        machineIdentity: "a".repeat(64),
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
        if ("lock" in outcome) {
          gateway = outcome.lock;
        }
        expect(outcome).toEqual({ error: expect.any(GatewayLockError) });
        expect(String("error" in outcome ? outcome.error : "")).toContain(
          "openclaw gateway recover-lock",
        );
        expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).toBe(payload);
      } finally {
        clearInterval(renew);
        await gateway?.release();
      }
    },
  );

  it.each([
    "stale",
    "exited",
    "local-exited",
    "renewing",
    "live",
    "deadline",
    "revoked",
    "clock-skew",
  ] as const)(
    "Doctor maintenance handles a %s container owner through shared admission",
    async (kind) => {
      const env = await makeEnv();
      const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
      vi.useFakeTimers();
      const began = Date.now();
      const paths = resolveGatewayLockPaths(env);
      const record = JSON.stringify({
        ...createLockPayload({ configPath: paths.configPath, startTime: 1 }),
        pid: kind === "live" ? process.pid : 2_147_483_647,
        startTime: undefined,
        processNamespace: {
          ...namespace,
          ...(kind === "live" || kind === "local-exited"
            ? {}
            : { host: "exited-container", pidNsInode: "foreign-namespace" }),
        },
      });
      fsSync.mkdirSync(path.dirname(paths.ownerLockPath), { recursive: true });
      fsSync.writeFileSync(paths.ownerLockPath, record);
      const renewedAt = new Date(
        began + (kind === "clock-skew" ? 60_000 : kind === "stale" ? -91_000 : 0),
      );
      fsSync.utimesSync(paths.ownerLockPath, renewedAt, renewedAt);
      const fsync = fsSync.fsyncSync.bind(fsSync);
      vi.spyOn(fsSync, "fsyncSync").mockImplementation((fd) => {
        fsync(fd);
        fsSync.futimesSync(fd, new Date(), new Date());
      });
      const renew =
        kind === "renewing"
          ? setInterval(() => {
              fsSync.utimesSync(paths.ownerLockPath, new Date(), new Date());
            }, 15_000)
          : undefined;
      const waiting = createDeferred();
      const log = vi.fn(() => waiting.resolve());
      let authorized = true;
      const admission = acquireDoctorGatewayMaintenanceOwner(
        path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
        env,
        {
          options: { repair: true },
          runtime: { log, error: vi.fn(), exit: vi.fn() },
          ...(kind === "deadline" || kind === "clock-skew"
            ? { deadlineMs: performance.now() + 5_000 }
            : {}),
          assertCurrent: () => {
            if (!authorized) {
              throw new Error("update owner was revoked");
            }
          },
        },
      ).then(
        (lock) => ({ lock }),
        (error: unknown) => ({ error }),
      );
      let owner: Awaited<ReturnType<typeof acquireDoctorGatewayMaintenanceOwner>> | undefined;
      try {
        if (kind !== "local-exited" && kind !== "live") {
          await awaitGateBeforeSettlement(
            waiting.promise,
            admission,
            "Doctor settled before waiting for the foreign container heartbeat",
          );
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining("exited-container/pid-ns foreign-namespace"),
          );
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining(`last renewed ${kind === "stale" ? 91 : 0} s ago`),
          );
          authorized = kind !== "revoked";
          await vi.advanceTimersByTimeAsync(
            kind === "deadline" || kind === "revoked" || kind === "clock-skew" ? 5_000 : 95_000,
          );
        }
        const result = await admission;
        if (kind === "local-exited") {
          if (!("lock" in result)) {
            throw result.error;
          }
          owner = result.lock;
          owner.assertCurrent();
          expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).not.toBe(record);
          expect(Date.now() - began).toBe(0);
        } else {
          expect(result).toEqual({ error: expect.any(Error) });
          if (!("error" in result)) {
            owner = result.lock;
            throw new Error("Expected refusal");
          }
          const message = String(result.error);
          if (kind === "revoked") {
            expect(message).toContain("update owner was revoked");
          } else {
            expect(message).toContain(
              kind === "live"
                ? `holder ${process.pid} is alive on this host, stop it first`
                : "exited-container/pid-ns foreign-namespace",
            );
            expect(message).toContain("last renewed");
            if (kind !== "live") {
              expect(message).toContain("openclaw gateway recover-lock");
            }
          }
          expect(Date.now() - began).toBe(
            kind === "live"
              ? 0
              : kind === "deadline" || kind === "revoked" || kind === "clock-skew"
                ? 5_000
                : 95_000,
          );
          expect(fsSync.readFileSync(paths.ownerLockPath, "utf8")).toBe(record);
        }
      } finally {
        clearInterval(renew);
        await owner?.release();
      }
    },
  );

  it("preserves a historical projection from a different host and boot before acquiring Gateway ownership", async () => {
    const env = await makeEnv();
    const namespace = mockLinuxNamespace(env.OPENCLAW_STATE_DIR);
    const { lockPath, configPath } = resolveLockPath(env);
    const payload = {
      ...createLockPayload({ configPath, startTime: 1, port: 18789 }),
      pid: 2_147_483_647,
      processNamespace: {
        ...namespace,
        host: `${namespace.host}-other`,
        identity: namespace.identity.replace(/[0-9a-f]/i, (digit) => (digit === "1" ? "2" : "1")),
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
  });
});
