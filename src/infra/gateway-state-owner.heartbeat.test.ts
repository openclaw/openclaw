import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { MessageChannel, receiveMessageOnPort, type Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  classifyGatewayLockProcessNamespace,
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  readGatewayLockProcessNamespace,
} from "./gateway-lock-payload.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import type { GatewayStateOwnerHeartbeatData } from "./gateway-state-owner-heartbeat.runtime.js";
import {
  acquireStateDatabaseSchemaLease,
  captureGatewayStateOwner,
} from "./gateway-state-owner.js";
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

function observeHeartbeatWorkers(fault?: "EIO" | "clock origin" | SharedArrayBuffer) {
  const workers: Worker[] = [];
  const ready: Promise<unknown>[] = [];
  const beats: BigInt64Array<SharedArrayBuffer>[] = [];
  const createWorker = workerCpu.createCpuTrackedWorker;
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((url, options) => {
    const data: unknown = options?.workerData;
    if (!isRecord(data) || !(data.lastBeat instanceof SharedArrayBuffer)) {
      throw new Error("Expected shared heartbeat observation");
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

it("keeps healthy custody when the heartbeat worker has a different clock origin", async () => {
  const { workers, ready } = observeHeartbeatWorkers("clock origin");
  const gateway = await acquireGatewayLock({
    allowInTests: true,
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-owner-clock-origin-") },
    timeoutMs: 0,
  });
  if (!gateway) {
    throw new Error("Expected Gateway custody");
  }
  try {
    await Promise.all(ready);
    expect(() => gateway.assertCurrent()).not.toThrow();
    expect(workers).toHaveLength(1);
  } finally {
    await gateway.release();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

async function startRuntime(locks: Record<string, string>) {
  vi.useFakeTimers();
  vi.resetModules();
  const { runGatewayStateOwnerHeartbeat } =
    await import("./gateway-state-owner-heartbeat.runtime.js");
  const events = new MessageChannel();
  const parent = new MessageChannel();
  const closed = once(parent.port2, "close");
  const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(lastBeat, 0, BigInt(Date.now()));
  runGatewayStateOwnerHeartbeat(
    {
      locks,
      intervalMs: 15_000,
      failureMs: 60_000,
      lastBeat: lastBeat.buffer,
      events: events.port2,
    } satisfies GatewayStateOwnerHeartbeatData,
    parent.port2,
  );
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
    async stop() {
      parent.port1.postMessage("stop");
      await closed;
      parent.port1.close();
      events.port1.close();
    },
  };
}

it("bounds persistent EIO renewal failures without losing healthy custody", async () => {
  const rootPath = path.join(tempDirs.make("openclaw-owner-heartbeat-io-"), "root.lock");
  fs.writeFileSync(rootPath, "root-owner");
  vi.spyOn(fs, "futimesSync").mockImplementation(() => {
    throw Object.assign(new Error("synthetic EIO renewing owner"), { code: "EIO" });
  });
  const runtime = await startRuntime({ [rootPath]: "root-owner" });
  const initialBeat = Atomics.load(runtime.lastBeat, 0);
  try {
    vi.advanceTimersByTime(59_999);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    const events = runtime.readEvents();
    expect(events).toContain(`${rootPath}: utimes renewal failed: synthetic EIO renewing owner`);
    expect(Atomics.load(runtime.lastBeat, 0)).toBe(initialBeat);
    expect(events.at(-1)).toBe(`${rootPath}: utimes renewal failed: synthetic EIO renewing owner`);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await runtime.stop();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the failure deadline ahead of mtime expiry after a slow successful touch", async () => {
  const rootPath = path.join(tempDirs.make("openclaw-owner-heartbeat-slow-"), "root.lock");
  fs.writeFileSync(rootPath, "root-owner");
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
  const runtime = await startRuntime({ [rootPath]: "root-owner" });
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

it("stops renewal when the wall clock moves behind the last heartbeat", async () => {
  const rootPath = path.join(tempDirs.make("openclaw-owner-heartbeat-clock-"), "root.lock");
  fs.writeFileSync(rootPath, "root-owner");
  const runtime = await startRuntime({ [rootPath]: "root-owner" });
  const initialBeat = Atomics.load(runtime.lastBeat, 0);
  const stamp = fs.statSync(rootPath).mtimeMs;
  try {
    vi.setSystemTime(Date.now() - 120_000);
    vi.advanceTimersByTime(15_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(Atomics.load(runtime.lastBeat, 0)).toBe(initialBeat);
    expect(fs.statSync(rootPath).mtimeMs).toBe(stamp);
    expect(runtime.readEvents()).toContain(`${rootPath}: heartbeat clock moved backwards`);
  } finally {
    await runtime.stop();
  }
});

it("bounds shared custody by the oldest mtime after clock rollback between locks", async () => {
  const root = tempDirs.make("openclaw-owner-heartbeat-between-locks-");
  const rootPath = path.join(root, "root.lock");
  const projectionPath = path.join(root, "projection.lock");
  const locks = { [rootPath]: "root-owner", [projectionPath]: "projection-owner" };
  for (const [lockPath, raw] of Object.entries(locks)) {
    fs.writeFileSync(lockPath, raw);
  }
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
  const runtime = await startRuntime(locks);
  try {
    shiftClock = true;
    vi.advanceTimersByTime(15_000);
    const oldestMtime = Math.min(
      fs.statSync(rootPath).mtimeMs,
      fs.statSync(projectionPath).mtimeMs,
    );
    expect(fs.statSync(projectionPath).mtimeMs).toBeLessThan(fs.statSync(rootPath).mtimeMs);
    expect(Number(Atomics.load(runtime.lastBeat, 0))).toBeLessThanOrEqual(oldestMtime);
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await runtime.stop();
  }
});

it("never backdates custody when clock rollback recovers before a partial failure", async () => {
  const root = tempDirs.make("openclaw-owner-heartbeat-captured-clock-");
  const rootPath = path.join(root, "root.lock");
  const projectionPath = path.join(root, "projection.lock");
  const locks = { [rootPath]: "root-owner", [projectionPath]: "projection-owner" };
  for (const [lockPath, raw] of Object.entries(locks)) {
    fs.writeFileSync(lockPath, raw);
  }
  const runtime = await startRuntime(locks);
  const initialBeat = Atomics.load(runtime.lastBeat, 0);
  const stamp = fs.statSync(rootPath).mtimeMs;
  const projectionInode = fs.statSync(projectionPath).ino;
  const touch = fs.futimesSync;
  vi.spyOn(fs, "futimesSync").mockImplementation((fd, atime, mtime) => {
    if (fs.fstatSync(fd).ino === projectionInode) {
      throw Object.assign(new Error("synthetic projection renewal failure"), { code: "EIO" });
    }
    touch(fd, atime, mtime);
  });
  const tick = Date.now() + 15_000;
  vi.spyOn(Date, "now")
    .mockReturnValue(tick)
    .mockReturnValueOnce(tick)
    .mockReturnValueOnce(tick - 120_000);
  try {
    vi.advanceTimersByTime(15_000);
    expect(fs.statSync(rootPath).mtimeMs).toBe(stamp);
    expect(Atomics.load(runtime.lastBeat, 0)).toBe(initialBeat);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.readEvents()).toContain(`${rootPath}: heartbeat clock moved backwards`);
  } finally {
    await runtime.stop();
  }
});

it.each(["EIO", "worker exit", "clock rollback"] as const)(
  "fences state admission with a visible reason after %s stops renewal",
  async (fault) => {
    const root = tempDirs.make("openclaw-owner-heartbeat-lost-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const { workers, ready, beats } = observeHeartbeatWorkers(fault === "EIO" ? fault : undefined);
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
      if (fault === "worker exit") {
        await worker.terminate();
      }
      expect(() => gateway.assertCurrent()).not.toThrow();
      Atomics.store(
        lastBeat,
        0,
        BigInt(Date.now() + (fault === "clock rollback" ? 60_001 : -60_001)),
      );
      const reason =
        fault === "EIO"
          ? "synthetic EIO"
          : fault === "clock rollback"
            ? "heartbeat clock moved backwards"
            : "utimes heartbeat renewal did not complete within 60 seconds";
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
  },
);

it("renews retained custody during synchronous work and never touches a successor", async () => {
  const { workers, ready } = observeHeartbeatWorkers();
  const root = tempDirs.make("openclaw-owner-worker-");
  const gateway = await acquireGatewayLock({
    allowInTests: true,
    env: { OPENCLAW_STATE_DIR: root },
    timeoutMs: 0,
  });
  if (!gateway) {
    throw new Error("Expected Gateway custody");
  }
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
            { ...namespace, pidNsInode: "foreign-observer" },
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
  const root = tempDirs.make("openclaw-owner-paused-");
  const gateway = await acquireGatewayLock({
    allowInTests: true,
    env: { OPENCLAW_STATE_DIR: root },
    timeoutMs: 0,
  });
  if (!gateway) {
    throw new Error("Expected Gateway custody");
  }
  try {
    expect(await Promise.all(ready)).toEqual([["paused"]]);
    const worker = workers[0];
    if (!worker) {
      throw new Error("Expected the paused heartbeat worker");
    }
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
  const root = tempDirs.make("openclaw-owner-heartbeat-release-");
  const rootPath = path.join(root, "root.lock");
  const projectionPath = path.join(root, "projection.lock");
  const locks = { [rootPath]: "root-owner", [projectionPath]: "projection-owner" };
  for (const [lockPath, raw] of Object.entries(locks)) {
    fs.writeFileSync(lockPath, raw);
  }
  const touch = fs.futimesSync;
  vi.spyOn(fs, "futimesSync").mockImplementation((fd, atime, mtime) => {
    if (fs.existsSync(projectionPath) && fs.fstatSync(fd).ino === fs.statSync(projectionPath).ino) {
      fs.unlinkSync(projectionPath);
    }
    touch(fd, atime, mtime);
  });
  const runtime = await startRuntime(locks);
  try {
    expect(() => vi.advanceTimersByTime(GATEWAY_OWNER_HEARTBEAT_STALE_MS + 2_000)).not.toThrow();
    expect(fs.existsSync(projectionPath)).toBe(false);
    expect(Atomics.load(runtime.lastBeat, 0)).toBeGreaterThan(0n);
    expect(vi.getTimerCount()).toBe(1);
    expect(Date.now() - fs.statSync(rootPath).mtimeMs).toBeLessThan(15_000);
    expect(runtime.readEvents().every((event) => event === null)).toBe(true);
  } finally {
    await runtime.stop();
  }
});
