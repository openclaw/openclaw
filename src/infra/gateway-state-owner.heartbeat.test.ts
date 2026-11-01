import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MessageChannel, receiveMessageOnPort, type Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  classifyGatewayLockProcessNamespace,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { startGatewayStateOwnerHeartbeat } from "./gateway-state-owner-heartbeat.js";
import type { GatewayStateOwnerHeartbeatData } from "./gateway-state-owner-heartbeat.runtime.js";
import {
  acquireStateDatabaseSchemaLease,
  captureGatewayStateOwner,
} from "./gateway-state-owner.js";
import { withRuntimeWorkerGeneration } from "./runtime-worker-generation.js";
import * as workerCpu from "./worker-cpu.js";

vi.mock("./gateway-lock-payload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-lock-payload.js")>()),
  GATEWAY_OWNER_HEARTBEAT_MS: 1_000,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

async function acquireGateway(prefix: string) {
  const root = tempDirs.make(prefix);
  const gateway = await acquireGatewayLock({
    allowInTests: true,
    env: { OPENCLAW_STATE_DIR: root },
    timeoutMs: 0,
  });
  if (!gateway) {
    throw new Error("Expected Gateway custody");
  }
  return { root, gateway };
}

function lockFixture(prefix: string, projection = false) {
  const root = tempDirs.make(prefix);
  const rootPath = path.join(root, "root.lock");
  const projectionPath = path.join(root, "projection.lock");
  const locks = {
    [rootPath]: "root-owner",
    ...(projection ? { [projectionPath]: "projection-owner" } : {}),
  };
  for (const [lockPath, raw] of Object.entries(locks)) {
    fs.writeFileSync(lockPath, raw);
  }
  return { root, rootPath, projectionPath, locks };
}

function observeHeartbeatWorkers(
  fault?: "EIO" | "clock origin" | SharedArrayBuffer,
  legacy = false,
) {
  const workers: Worker[] = [];
  const ready: Promise<unknown>[] = [];
  const beats: BigInt64Array<SharedArrayBuffer>[] = [];
  const createWorker = workerCpu.createCpuTrackedWorker;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((url, options) => {
    const data: unknown = options?.workerData;
    if (!isRecord(data) || !(data.lastBeat instanceof SharedArrayBuffer)) {
      throw new Error("Expected shared heartbeat observation");
    }
    if (legacy) {
      delete data.clock;
    }
    beats.push(new BigInt64Array(data.lastBeat));
    const entry = fault
      ? new URL(
          `data:text/javascript,${encodeURIComponent(`
              import fs from "node:fs";
              import { parentPort, workerData } from "node:worker_threads";
              if (workerData.clockOrigin) {
                const monotonic = process.hrtime.bigint.bind(process.hrtime);
                process.hrtime.bigint = () => monotonic() - 120_000_000_000n;
              } else if (workerData.pause) {
                const pause = new Int32Array(workerData.pause);
                let paused = false;
                for (const name of ["utimesSync", "futimesSync"]) {
                  const touch = fs[name];
                  fs[name] = (...args) => {
                    if (!paused) {
                      paused = true;
                      parentPort.postMessage("paused");
                      Atomics.wait(pause, 0, 0);
                    }
                    return touch(...args);
                  };
                }
              } else {
                fs.futimesSync = () => { throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); };
              }
              await import(${JSON.stringify(String(url))});
            `)}`,
        )
      : url;
    const worker = createWorker(
      entry,
      fault instanceof SharedArrayBuffer
        ? { ...options, workerData: { ...data, pause: fault, intervalMs: 1 } }
        : fault === "clock origin"
          ? { ...options, workerData: { ...data, clockOrigin: true } }
          : options,
    );
    workers.push(worker);
    ready.push(once(worker, "message"));
    return worker;
  });
  return { workers, ready, beats };
}

it.each([false, true])("keeps custody across worker clock origins (legacy=%s)", async (legacy) => {
  const { workers, ready } = observeHeartbeatWorkers("clock origin", legacy);
  const { gateway } = await acquireGateway("openclaw-owner-clock-origin-");
  try {
    await Promise.all(ready);
    expect(() => gateway.assertCurrent()).not.toThrow();
    expect(workers).toHaveLength(1);
  } finally {
    await gateway.release();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it("keeps the selected heartbeat generation alive through native retirement", async () => {
  const root = tempDirs.make("openclaw-owner-generation-");
  const lockPath = path.join(root, "root.lock");
  fs.writeFileSync(lockPath, "root-owner");
  const { workers, ready } = observeHeartbeatWorkers();
  let heartbeat: ReturnType<typeof startGatewayStateOwnerHeartbeat> | undefined;
  const markerPath = path.join(root, "selected");
  const release = vi.fn(async () => {
    expect(workers).toHaveLength(1);
    expect(workers[0]?.threadId).toBe(-1);
  });
  try {
    await withRuntimeWorkerGeneration(async (bind) => {
      bind((url) => {
        const retainedPath = path.join(root, `retained${path.extname(fileURLToPath(url))}`);
        fs.writeFileSync(
          retainedPath,
          `
          import fs from "node:fs";
          fs.writeFileSync(${JSON.stringify(markerPath)}, "selected");
          await import(${JSON.stringify(url.href)});
        `,
        );
        return pathToFileURL(retainedPath);
      });
      heartbeat = startGatewayStateOwnerHeartbeat(
        new Set([{ lockPath, verifyStillHeld: () => true }]),
        (error) => {
          throw error;
        },
      );
      await Promise.all(ready);
      expect(fs.readFileSync(markerPath, "utf8")).toBe("selected");
      expect(heartbeat.inspect()).toBeGreaterThan(0);
      await heartbeat.stop();
    }, release);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await heartbeat?.stop();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

async function startRuntime(
  locks: Record<string, string>,
  timing?: { clock?: "epoch"; seed: bigint },
) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers();
  }
  vi.resetModules();
  const { runGatewayStateOwnerHeartbeat } =
    await import("./gateway-state-owner-heartbeat.runtime.js");
  const events = new MessageChannel();
  const parent = new MessageChannel();
  const closed = once(parent.port2, "close");
  const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(lastBeat, 0, timing?.seed ?? BigInt(Date.now()));
  runGatewayStateOwnerHeartbeat(
    {
      locks,
      clock: timing ? timing.clock : "epoch",
      intervalMs: 15_000,
      failureMs: 60_000,
      lastBeat: lastBeat.buffer,
      events: events.port2,
    } satisfies GatewayStateOwnerHeartbeatData,
    parent.port2,
  );
  const stop = async () => {
    parent.port1.postMessage("stop");
    await closed;
    parent.port1.close();
    events.port1.close();
  };
  return {
    lastBeat,
    readEvents() {
      const messages: unknown[] = [];
      let message;
      while ((message = receiveMessageOnPort(events.port1))) {
        messages.push(message.message);
      }
      return messages;
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

it.each(["reparented", "unchanged ppid"])(
  "settles maintenance with a lost launcher (%s) before forced termination",
  async (kind) => {
    const rootPath = path.join(tempDirs.make("openclaw-owner-orphan-"), "root.lock");
    const raw = JSON.stringify({
      pid: process.pid,
      parentPid: kind === "reparented" ? process.ppid + 1 : process.ppid,
      ...(kind === "unchanged ppid" ? { parentStartTime: 0 } : {}),
      role: "sqlite-maintenance",
      createdAt: new Date().toISOString(),
      configPath: "synthetic-config",
    });
    fs.writeFileSync(rootPath, raw);
    const oldStamp = new Date(Date.now() - 30_000);
    fs.utimesSync(rootPath, oldStamp, oldStamp);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    await using runtime = await startRuntime({ [rootPath]: raw });
    expect(runtime.readEvents()).toContain("parent-lost");
    expect(kill.mock.calls).toEqual(kind === "unchanged ppid" ? [[process.ppid, 0]] : []);
    expect(fs.statSync(rootPath).mtimeMs).toBeGreaterThan(oldStamp.getTime());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kill).toHaveBeenLastCalledWith(process.pid, "SIGKILL");
  },
);

it.each(["resume", "replace", "stop"] as const)(
  "keeps the main thread responsive during expired timer renewal: %s",
  async (ending) => {
    const { rootPath } = lockFixture("openclaw-owner-async-renewal-");
    const held = new Set([{ lockPath: rootPath, verifyStillHeld: () => true }]);
    const { workers, ready, beats } = observeHeartbeatWorkers();
    const lost = vi.fn();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const heartbeat = startGatewayStateOwnerHeartbeat(held, lost);
    const opened = createDeferredCore();
    const resume = createDeferredCore();
    const open = fs.promises.open.bind(fs.promises);
    const openSync = fs.openSync;
    let synchronousOpens = 0;
    try {
      await Promise.all(ready);
      await workers[0]!.terminate();
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        if (args[0] === rootPath) {
          opened.resolve();
          await resume.promise;
        }
        return open(...args);
      });
      vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
        if (pathname === rootPath) {
          synchronousOpens++;
        }
        return openSync(pathname, flags, mode);
      });
      const stale = BigInt(Date.now() - 65_000);
      Atomics.store(beats[0]!, 0, stale);
      vi.advanceTimersByTime(60_000);
      expect(synchronousOpens).toBe(0);
      await opened.promise;
      let responsive = false;
      setTimeout(() => {
        responsive = true;
      }, 0);
      vi.advanceTimersByTime(0);
      expect(responsive).toBe(true);
      expect(Atomics.load(beats[0]!, 0)).toBe(stale);
      if (ending === "replace") {
        fs.renameSync(rootPath, `${rootPath}.retired`);
        fs.copyFileSync(`${rootPath}.retired`, rootPath);
      } else if (ending === "stop") {
        held.clear();
        void heartbeat.stop();
      }
      resume.resolve();
      if (ending === "resume") {
        await vi.waitFor(() => expect(Atomics.load(beats[0]!, 0)).toBeGreaterThan(stale));
        expect(lost).not.toHaveBeenCalled();
      } else if (ending === "replace") {
        await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
        expect(lost.mock.calls[0]?.[0]).toHaveProperty(
          "message",
          expect.stringContaining("removed or replaced"),
        );
        expect(Atomics.load(beats[0]!, 0)).toBe(stale);
      } else {
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0));
        expect(lost).not.toHaveBeenCalled();
        expect(Atomics.load(beats[0]!, 0)).toBe(stale);
      }
    } finally {
      resume.resolve();
      await heartbeat.stop();
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);

it.each([65_000, -5_000])(
  "renews unchanged worker custody after a heartbeat age of %s ms",
  async (age) => {
    const rootPath = path.join(tempDirs.make("openclaw-owner-gap-"), "root.lock");
    fs.writeFileSync(rootPath, "root-owner");
    vi.useFakeTimers();
    const runtime = await startRuntime(
      { [rootPath]: "root-owner" },
      { clock: "epoch", seed: BigInt(Date.now() - age) },
    );
    try {
      expect(Number(Atomics.load(runtime.lastBeat, 0))).toBe(Date.now());
      expect(fs.statSync(rootPath).mtimeMs).toBe(Date.now());
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await runtime.stop();
    }
  },
);

it.each([65_000, -5_000, "replacement"] as const)(
  "rechecks parent custody after %s before fencing",
  async (age) => {
    const { workers, ready, beats } = observeHeartbeatWorkers();
    const { gateway } = await acquireGateway("openclaw-owner-parent-gap-");
    try {
      await Promise.all(ready);
      await workers[0]!.terminate();
      if (age === "replacement") {
        fs.renameSync(gateway.lockPath, `${gateway.lockPath}.retired`);
        fs.copyFileSync(`${gateway.lockPath}.retired`, gateway.lockPath);
      }
      Atomics.store(beats[0]!, 0, BigInt(Date.now() - (typeof age === "number" ? age : 65_000)));
      if (age === "replacement") {
        expect(() => gateway.assertCurrent()).toThrow("owner lock was removed or replaced");
      } else {
        expect(() => gateway.assertCurrent()).not.toThrow();
        expect(Date.now() - Number(Atomics.load(beats[0]!, 0))).toBeLessThan(1_000);
      }
    } finally {
      await gateway.release();
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);

it.each([
  { clock: "monotonic", age: 0, renew: true },
  { clock: "epoch", age: 0, renew: true },
  { clock: "monotonic", age: 60_001, renew: true },
  { clock: "epoch", age: 60_001, renew: true },
  { clock: "monotonic", age: 120_001, renew: false },
  { clock: "epoch", age: -1, renew: false },
  { clock: "monotonic", age: -1, renew: false },
  { clock: "missing creation", age: 0, renew: false },
  { clock: "future creation", age: 0, renew: false },
] as const)(
  "preserves unmarked $clock custody with seed age $age",
  async ({ clock, age, renew }) => {
    // Bun workers have independent hrtime origins, so unmarked monotonic custody is refused.
    const shouldRenew = renew && !(process.versions.bun && clock === "monotonic");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(500_000_000_000n);
    vi.spyOn(process, "uptime").mockReturnValue(120);
    const rootPath = path.join(tempDirs.make("openclaw-owner-legacy-clock-"), "root.lock");
    const raw = JSON.stringify({
      pid: process.pid,
      configPath: "synthetic-config",
      createdAt:
        clock === "missing creation"
          ? undefined
          : new Date(Date.now() + (clock === "future creation" ? 1 : -120_000)).toISOString(),
    });
    fs.writeFileSync(rootPath, raw);
    const previous = new Date(Date.now() - 300_000);
    fs.utimesSync(rootPath, previous, previous);
    const seed = BigInt((clock === "monotonic" ? 500_000 : Date.now()) - age);
    await using runtime = await startRuntime({ [rootPath]: raw }, { clock: undefined, seed });
    expect(vi.getTimerCount()).toBe(shouldRenew ? 1 : 0);
    expect(fs.statSync(rootPath).mtimeMs).toBe(shouldRenew ? Date.now() : previous.getTime());
    if (!shouldRenew) {
      expect(Atomics.load(runtime.lastBeat, 0)).toBe(seed);
      expect(runtime.readEvents()).toEqual([
        `${rootPath}: heartbeat clock could not be identified`,
      ]);
    }
  },
);

it("bounds persistent EIO renewal failures without losing healthy custody", async () => {
  const { rootPath, locks } = lockFixture("openclaw-owner-heartbeat-io-");
  vi.spyOn(fs, "futimesSync").mockImplementation(() => {
    throw Object.assign(new Error("synthetic EIO renewing owner"), { code: "EIO" });
  });
  {
    await using runtime = await startRuntime(locks);
    const initialBeat = Atomics.load(runtime.lastBeat, 0);
    vi.advanceTimersByTime(59_999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    const events = runtime.readEvents();
    expect(events).toContain(`${rootPath}: utimes renewal failed: synthetic EIO renewing owner`);
    expect(Atomics.load(runtime.lastBeat, 0)).toBe(initialBeat);
    expect(events.at(-1)).toBe(`${rootPath}: utimes renewal failed: synthetic EIO renewing owner`);
    expect(vi.getTimerCount()).toBe(0);
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the failure deadline ahead of mtime expiry after a slow successful touch", async () => {
  const { rootPath, locks } = lockFixture("openclaw-owner-heartbeat-slow-");
  const touch = fs.futimesSync;
  let first = true;
  vi.spyOn(fs, "futimesSync").mockImplementation((lockPath, atime, mtime) => {
    if (!first) {
      throw Object.assign(new Error("synthetic EIO after slow touch"), { code: "EIO" });
    }
    first = false;
    // The syscall completes later, but the mtime remains the timestamp supplied at entry.
    vi.advanceTimersByTime(40_000);
    touch(lockPath, atime, mtime);
  });
  const runtime = await startRuntime(locks);
  try {
    vi.advanceTimersByTime(19_999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(Date.now() - fs.statSync(rootPath).mtimeMs).toBeLessThan(
      GATEWAY_OWNER_HEARTBEAT_STALE_MS,
    );
  } finally {
    await runtime.stop();
  }
});

it("renews physical custody when the wall clock moves behind the last heartbeat", async () => {
  const { rootPath, locks } = lockFixture("openclaw-owner-heartbeat-clock-");
  await using runtime = await startRuntime(locks);
  vi.setSystemTime(Date.now() - 120_000);
  vi.advanceTimersByTime(15_000);
  expect(vi.getTimerCount()).toBe(1);
  expect(Number(Atomics.load(runtime.lastBeat, 0))).toBe(Date.now());
  expect(fs.statSync(rootPath).mtimeMs).toBe(Date.now());
  expect(runtime.readEvents()).toEqual([null, null]);
});

it("bounds shared custody by the oldest mtime after clock rollback between locks", async () => {
  const { rootPath, projectionPath, locks } = lockFixture(
    "openclaw-owner-heartbeat-between-locks-",
    true,
  );
  const rootInode = fs.statSync(rootPath).ino;
  const touch = fs.futimesSync;
  let shiftClock = false;
  vi.spyOn(fs, "futimesSync").mockImplementation((fd, atime, mtime) => {
    touch(fd, atime, mtime);
    if (shiftClock) {
      if (fs.fstatSync(fd).ino === rootInode) {
        vi.setSystemTime(Date.now() - 10_000);
      } else {
        vi.setSystemTime(Date.now() + 10_000);
        shiftClock = false;
      }
    }
  });
  await using runtime = await startRuntime(locks);
  shiftClock = true;
  vi.advanceTimersByTime(15_000);
  const oldestMtime = Math.min(fs.statSync(rootPath).mtimeMs, fs.statSync(projectionPath).mtimeMs);
  expect(fs.statSync(projectionPath).mtimeMs).toBeLessThan(fs.statSync(rootPath).mtimeMs);
  expect(Number(Atomics.load(runtime.lastBeat, 0))).toBeLessThanOrEqual(oldestMtime);
  expect(vi.getTimerCount()).toBe(1);
});

it("never publishes renewed custody after a partial failure across clock rollback", async () => {
  const { rootPath, projectionPath, locks } = lockFixture(
    "openclaw-owner-heartbeat-captured-clock-",
    true,
  );
  await using runtime = await startRuntime(locks);
  const initialBeat = Atomics.load(runtime.lastBeat, 0);
  const projectionInode = fs.statSync(projectionPath).ino;
  const touch = fs.futimesSync;
  vi.spyOn(fs, "futimesSync").mockImplementation((fd, atime, mtime) => {
    if (fs.fstatSync(fd).ino === projectionInode) {
      throw Object.assign(new Error("synthetic projection renewal failure"), { code: "EIO" });
    }
    touch(fd, atime, mtime);
  });
  vi.setSystemTime(Date.now() - 120_000);
  vi.advanceTimersByTime(15_000);
  expect(fs.statSync(rootPath).mtimeMs).toBe(Date.now());
  expect(Atomics.load(runtime.lastBeat, 0)).toBe(initialBeat);
  expect(vi.getTimerCount()).toBe(0);
  expect(runtime.readEvents()).toContain(
    `${projectionPath}: utimes renewal failed: synthetic projection renewal failure`,
  );
});

it("fences state admission with a visible reason when renewal still fails after the deadline", async () => {
  const root = tempDirs.make("openclaw-owner-heartbeat-lost-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  const { workers, ready, beats } = observeHeartbeatWorkers("EIO");
  const gateway = await acquireGatewayLock({
    allowInTests: true,
    env: { OPENCLAW_STATE_DIR: root },
    timeoutMs: 0,
  });
  if (!gateway) {
    throw new Error("Expected Gateway custody");
  }
  try {
    const owner = captureGatewayStateOwner(databasePath);
    if (!owner) {
      throw new Error("Expected captured Gateway custody");
    }
    await Promise.all(ready);
    const worker = workers[0];
    const lastBeat = beats[0];
    if (!worker || !lastBeat) {
      throw new Error("Expected one heartbeat worker and its shared observation");
    }
    vi.spyOn(fs, "futimesSync").mockImplementation(() => {
      throw Object.assign(new Error("synthetic EIO"), { code: "EIO" });
    });
    expect(() => gateway.assertCurrent()).not.toThrow();
    Atomics.store(lastBeat, 0, BigInt(Date.now() - 60_001));
    const reason = "synthetic EIO";
    expect(() => gateway.assertCurrent()).toThrow(reason);
    expect(owner.signal.aborted).toBe(true);
    expect(owner.signal.reason).toMatchObject({
      message: expect.stringContaining(gateway.lockPath),
    });
    expect(() => owner.assertCurrent()).toThrow(reason);
    expect(() => acquireStateDatabaseSchemaLease(databasePath)).toThrow(
      expect.objectContaining({
        name: "GatewayStateOwnerContentionError",
        cause: owner.signal.reason,
      }),
    );
    expect(workers).toHaveLength(1);
  } finally {
    await gateway.release();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it("renews retained custody during synchronous work and never touches a successor", async () => {
  const { workers, ready } = observeHeartbeatWorkers();
  const { root, gateway } = await acquireGateway("openclaw-owner-worker-");
  const retained = acquireStateDatabaseSchemaLease(path.join(root, "state", "openclaw.sqlite"));
  try {
    await Promise.all(ready);
    const files = [gateway.lockPath, gateway.stateLockPath].map((lockPath) => ({
      lockPath,
      raw: fs.readFileSync(lockPath, "utf8"),
      before: fs.statSync(lockPath, { bigint: true }),
    }));
    await gateway.release();
    // Real synchronous blocking is the regression: a parent timer cannot run here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
    retained.assertCurrent();
    const namespace = readGatewayLockProcessNamespace();
    expect(namespace).not.toBeNull();
    // Give the production classifier a two-second freshness window without changing its API.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + GATEWAY_OWNER_HEARTBEAT_STALE_MS - 2_000);
    for (const file of files) {
      const after = fs.statSync(file.lockPath, { bigint: true });
      expect(after.mtimeNs).toBeGreaterThan(file.before.mtimeNs);
      expect(after.ino).toBe(file.before.ino);
      expect(fs.readFileSync(file.lockPath, "utf8")).toBe(file.raw);
      if (namespace && "pidNsInode" in namespace) {
        expect(
          classifyGatewayLockProcessNamespace(
            { processNamespace: { ...namespace, pidNsInode: "foreign-observer" } },
            file.lockPath,
          ),
        ).toBe("unknown");
      }
    }
    vi.mocked(Date.now).mockRestore();
    fs.unlinkSync(gateway.lockPath);
    fs.writeFileSync(gateway.lockPath, "successor");
    const replaced = files.map((file) => fs.statSync(file.lockPath, { bigint: true }).mtimeNs);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_500);
    expect(files.map((file) => fs.statSync(file.lockPath, { bigint: true }).mtimeNs)).toEqual(
      replaced,
    );
    expect(() => retained.assertCurrent()).toThrow("no longer current");
    expect(workers).toHaveLength(1);
    const worker = workers[0];
    if (!worker) {
      throw new Error("Expected the retained heartbeat worker");
    }
    const exited = once(worker, "exit");
    retained.release();
    await exited;
    expect(fs.readFileSync(gateway.lockPath, "utf8")).toBe("successor");
    expect(fs.existsSync(gateway.stateLockPath)).toBe(false);
  } finally {
    retained.release();
    await gateway.release();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it("never renews a successor after suspension between verification and the timestamp syscall", async () => {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const { workers, ready } = observeHeartbeatWorkers(pause.buffer);
  const { root, gateway } = await acquireGateway("openclaw-owner-paused-");
  try {
    expect(await Promise.all(ready)).toEqual([["paused"]]);
    const worker = workers[0]!;
    const owner = captureGatewayStateOwner(path.join(root, "state", "openclaw.sqlite"))!;
    const exited = once(worker, "exit");
    const held = fs.statSync(gateway.lockPath, { bigint: true });
    fs.renameSync(gateway.lockPath, `${gateway.lockPath}.retired`);
    fs.writeFileSync(gateway.lockPath, "successor");
    const stamp = new Date(Date.now() + 60_000);
    fs.utimesSync(gateway.lockPath, stamp, stamp);
    const successor = fs.statSync(gateway.lockPath, { bigint: true });
    expect(successor.ino).not.toBe(held.ino);
    Atomics.store(pause, 0, 1);
    Atomics.notify(pause, 0);
    await exited;
    expect(owner.signal.aborted).toBe(true);
    expect(owner.signal.reason.message).toContain("owner lock was removed or replaced");
    expect(fs.statSync(gateway.lockPath, { bigint: true }).mtimeNs).toBe(successor.mtimeNs);
    expect(fs.readFileSync(gateway.lockPath, "utf8")).toBe("successor");
  } finally {
    Atomics.store(pause, 0, 1);
    Atomics.notify(pause, 0);
    await gateway.release();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

it("keeps renewing the root when a projection disappears during its heartbeat", async () => {
  const { rootPath, projectionPath, locks } = lockFixture(
    "openclaw-owner-heartbeat-release-",
    true,
  );
  const touch = fs.futimesSync;
  vi.spyOn(fs, "futimesSync").mockImplementation((fd, atime, mtime) => {
    if (fs.existsSync(projectionPath) && fs.fstatSync(fd).ino === fs.statSync(projectionPath).ino) {
      fs.unlinkSync(projectionPath);
    }
    touch(fd, atime, mtime);
  });
  await using runtime = await startRuntime(locks);
  expect(() => vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_STALE_MS + 2_000)).not.toThrow();
  expect(fs.existsSync(projectionPath)).toBe(false);
  expect(Atomics.load(runtime.lastBeat, 0)).toBeGreaterThan(0n);
  expect(vi.getTimerCount()).toBe(1);
  expect(Date.now() - fs.statSync(rootPath).mtimeMs).toBeLessThan(15_000);
  expect(runtime.readEvents().every((event) => event === null)).toBe(true);
});
