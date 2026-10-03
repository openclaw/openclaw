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

function observeHeartbeatWorkers(fault?: "EIO") {
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
    const entry =
      fault === "EIO"
        ? new URL(
            `data:text/javascript,${encodeURIComponent(`
              import fs from "node:fs";
              fs.utimesSync = () => { throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); };
              await import(${JSON.stringify(String(url))});
            `)}`,
          )
        : url;
    const worker = createWorker(entry, options);
    workers.push(worker);
    ready.push(once(worker, "message"));
    return worker;
  });
  return { workers, ready, beats };
}

async function startRuntime(locks: Record<string, string>) {
  vi.useFakeTimers();
  vi.resetModules();
  const { runGatewayStateOwnerHeartbeat } =
    await import("./gateway-state-owner-heartbeat.runtime.js");
  const events = new MessageChannel();
  const parent = new MessageChannel();
  const closed = once(parent.port2, "close");
  const lastBeat = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
  Atomics.store(lastBeat, 0, process.hrtime.bigint() / 1_000_000n);
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

it.each(["persistent", "transient"] as const)(
  "bounds %s EIO renewal failures without losing healthy custody",
  async (kind) => {
    const rootPath = path.join(tempDirs.make("openclaw-owner-heartbeat-io-"), "root.lock");
    fs.writeFileSync(rootPath, "root-owner");
    const touch = fs.utimesSync;
    let failures = 0;
    vi.spyOn(fs, "utimesSync").mockImplementation((lockPath, atime, mtime) => {
      if (kind === "persistent" || failures++ < 1) {
        throw Object.assign(new Error("synthetic EIO renewing owner"), { code: "EIO" });
      }
      touch(lockPath, atime, mtime);
    });
    const runtime = await startRuntime({ [rootPath]: "root-owner" });
    const initialBeat = Atomics.load(runtime.lastBeat, 0);
    try {
      vi.advanceTimersByTime(59_999);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1);
      const events = runtime.readEvents();
      expect(events).toContain(`${rootPath}: utimes renewal failed: synthetic EIO renewing owner`);
      if (kind === "persistent") {
        expect(Atomics.load(runtime.lastBeat, 0)).toBe(initialBeat);
        expect(events.at(-1)).toBe(
          `${rootPath}: utimes renewal failed: synthetic EIO renewing owner`,
        );
        expect(vi.getTimerCount()).toBe(0);
      } else {
        expect(Atomics.load(runtime.lastBeat, 0)).toBeGreaterThan(initialBeat);
        expect(vi.getTimerCount()).toBe(1);
        expect(events.at(-1)).toBeNull();
        expect(Date.now() - fs.statSync(rootPath).mtimeMs).toBeLessThan(15_000);
        expect(fs.readFileSync(rootPath, "utf8")).toBe("root-owner");
      }
    } finally {
      await runtime.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps the failure deadline ahead of mtime expiry after a slow successful touch", async () => {
  const rootPath = path.join(tempDirs.make("openclaw-owner-heartbeat-slow-"), "root.lock");
  fs.writeFileSync(rootPath, "root-owner");
  const touch = fs.utimesSync;
  let first = true;
  vi.spyOn(fs, "utimesSync").mockImplementation((lockPath, atime, mtime) => {
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

it.each(["EIO", "worker exit"] as const)(
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
      Atomics.store(lastBeat, 0, process.hrtime.bigint() / 1_000_000n - 60_001n);
      const reason =
        fault === "EIO"
          ? "synthetic EIO"
          : "utimes heartbeat renewal did not complete within 60 seconds";
      expect(() => gateway.assertCurrent()).toThrow(reason);
      expect(owner.signal.aborted).toBe(true);
      expect(owner.signal.reason).toMatchObject({
        message: expect.stringContaining(gateway.lockPath),
      });
      expect(() => owner.assertCurrent()).toThrow(reason);
      expect(() => acquireStateDatabaseSchemaLease(databasePath)).toThrow(reason);
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

it("keeps renewing the root when a projection disappears during its heartbeat", async () => {
  const root = tempDirs.make("openclaw-owner-heartbeat-release-");
  const rootPath = path.join(root, "root.lock");
  const projectionPath = path.join(root, "projection.lock");
  const locks = { [rootPath]: "root-owner", [projectionPath]: "projection-owner" };
  for (const [lockPath, raw] of Object.entries(locks)) {
    fs.writeFileSync(lockPath, raw);
  }
  const touch = fs.utimesSync;
  vi.spyOn(fs, "utimesSync").mockImplementation((lockPath, atime, mtime) => {
    if (lockPath === projectionPath) {
      fs.unlinkSync(projectionPath);
    }
    touch(lockPath, atime, mtime);
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
