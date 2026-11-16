import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTrackedWorkerCpuSources } from "../../infra/worker-cpu.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createGatewayEventLoopHealthMonitor } from "./event-loop-health.js";

const hostFs = vi.hoisted(() => {
  const read =
    vi.fn<
      (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => Promise<{ bytesRead: number; buffer: Buffer }>
    >();
  const close = vi.fn<() => Promise<void>>();
  const open =
    vi.fn<(path: string, flags: string) => Promise<{ read: typeof read; close: typeof close }>>();
  const readFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>();
  return { open, read, close, readFile };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  open: hostFs.open,
  readFile: hostFs.readFile,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  cpus: vi.fn(),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));
vi.mock("../../infra/worker-cpu.js", () => ({ getTrackedWorkerCpuSources: vi.fn() }));

const monitors: ReturnType<typeof createGatewayEventLoopHealthMonitor>[] = [];
let now = 10_000;
let clock: ReturnType<typeof createGatewaySchedulerClock>;
let revision = 0;
let workers: ReturnType<typeof getTrackedWorkerCpuSources>["workers"];
const workerUsage = vi.fn<() => Promise<NodeJS.CpuUsage | undefined>>();
const mainThreadUsage = vi.fn<() => NodeJS.CpuUsage>();

function hostCpu(user: number, idle: number) {
  return { model: "test", speed: 1, times: { user, idle, nice: 0, sys: 0, irq: 0 } };
}

beforeEach(() => {
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    versions: { ...process.versions, bun: undefined },
  });
  now = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(process, "cpuUsage").mockImplementation((previous) => ({
    user: now * 2_000 - (previous?.user ?? 0),
    system: 0,
  }));
  vi.spyOn(performance, "eventLoopUtilization").mockImplementation(() => ({
    idle: now,
    active: 0,
    utilization: 0.05,
  }));
  clock = createGatewaySchedulerClock(now);
  revision = 0;
  workers = [{ cpuUsage: workerUsage }];
  workerUsage.mockReset().mockImplementation(async () => ({ user: now * 500, system: 0 }));
  vi.mocked(getTrackedWorkerCpuSources).mockImplementation(() => ({
    workers,
    revision,
    currentRevision: () => revision,
  }));
  mainThreadUsage.mockReset().mockImplementation(() => ({ user: now * 250, system: 0 }));
  vi.spyOn(process, "threadCpuUsage").mockImplementation(mainThreadUsage);
  vi.mocked(cpus)
    .mockReset()
    .mockImplementation(() => [hostCpu(now, 0), hostCpu(now / 2, now / 2)]);
});
afterEach(() => {
  for (const monitor of monitors.splice(0)) {
    monitor.stop();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function createMonitor() {
  const monitor = createGatewayEventLoopHealthMonitor({
    scheduler: createTestGatewayScheduler(clock.clock),
  });
  monitors.push(monitor);
  await setImmediate();
  return monitor;
}

async function sample(elapsedMs = 1_000) {
  now += elapsedMs;
  await clock.advanceTo(now);
  // CPU replies publish asynchronously; settle them before advancing the injected clock again.
  await setImmediate();
}

describe("CPU breakdown sampling", () => {
  it.each(["Node", "Bun"])("measures independent CPU counters supported by %s", async (runtime) => {
    if (runtime === "Bun") {
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.4.3" } });
    }
    const monitor = await createMonitor();
    expect(monitor.snapshot()).toBeUndefined();
    await sample();
    const snapshot = monitor.snapshot();
    expect(snapshot).toMatchObject({ cpuCoreRatio: 2, utilization: 0.05 });
    expect(snapshot?.cpuBreakdown).toEqual({
      mainThreadCoreRatio: 0.25,
      hostUtilization: 0.75,
      hostCpuCount: 2,
      ...(runtime === "Node" ? { workerCoreRatio: 0.5, otherThreadsCoreRatio: 1.25 } : {}),
    });
    if (runtime === "Bun") {
      expect(workerUsage).not.toHaveBeenCalled();
    }
    const counts = [workerUsage.mock.calls.length, vi.mocked(cpus).mock.calls.length];
    for (let index = 0; index < 50; index++) {
      expect(monitor.snapshot()).toBe(snapshot);
      monitor.persistentDegradationSnapshot();
    }
    expect([workerUsage.mock.calls.length, vi.mocked(cpus).mock.calls.length]).toEqual(counts);
  });

  it("keeps collection failures unavailable and requires fresh windows on recovery", async () => {
    mainThreadUsage.mockImplementation(() => {
      throw new Error("unsupported");
    });
    vi.mocked(cpus).mockReturnValue([]);
    workerUsage.mockResolvedValue(undefined);
    const monitor = await createMonitor();
    await sample();
    expect(monitor.snapshot()).toMatchObject({ cpuCoreRatio: 2, cpuBreakdown: {} });
    expect(Object.keys(monitor.snapshot()!.cpuBreakdown!)).toEqual([]);
    mainThreadUsage.mockImplementation(() => ({ user: now * 250, system: 0 }));
    vi.mocked(cpus).mockImplementation(() => [hostCpu(now, now)]);
    workerUsage.mockImplementation(async () => ({ user: now * 500, system: 0 }));
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown).toEqual({ hostCpuCount: 1 });
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown).toEqual({
      mainThreadCoreRatio: 0.25,
      workerCoreRatio: 0.5,
      otherThreadsCoreRatio: 1.25,
      hostUtilization: 0.5,
      hostCpuCount: 1,
    });
  });

  it.each(["counter rollback", "topology change", "no ticks", "invalid ticks", "throw"])(
    "does not fabricate idle host utilization after %s",
    async (failure) => {
      const monitor = await createMonitor();
      if (failure === "counter rollback") {
        vi.mocked(cpus).mockReturnValue([hostCpu(0, 0), hostCpu(0, 0)]);
      }
      if (failure === "topology change") {
        vi.mocked(cpus).mockReturnValue([hostCpu(now + 1_000, 0)]);
      }
      if (failure === "no ticks") {
        vi.mocked(cpus).mockReturnValue([hostCpu(now, 0), hostCpu(now / 2, now / 2)]);
      }
      if (failure === "invalid ticks") {
        vi.mocked(cpus).mockReturnValue([hostCpu(Number.NaN, 0)]);
      }
      if (failure === "throw") {
        vi.mocked(cpus).mockImplementation(() => {
          throw new Error("unavailable");
        });
      }
      await sample();
      expect(monitor.snapshot()?.cpuBreakdown?.hostUtilization).toBeUndefined();
      expect(monitor.snapshot()?.cpuCoreRatio).toBe(2);
    },
  );

  it("invalidates worker rates across churn, including workers that start and exit between samples", async () => {
    const monitor = await createMonitor();
    revision += 2;
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBeUndefined();
    expect(monitor.snapshot()?.cpuBreakdown?.otherThreadsCoreRatio).toBeUndefined();
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBe(0.5);
    workers = [];
    revision++;
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBeUndefined();
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBe(0);
  });

  it.each(["timeout", "reset", "stop", "worker churn"] as const)(
    "fences pending worker replies after %s without delaying process samples",
    async (action) => {
      const monitor = await createMonitor();
      const slow = createDeferredCore<NodeJS.CpuUsage>();
      workerUsage.mockReturnValueOnce(slow.promise);
      await sample();
      const health = monitor.snapshot();
      expect(health?.cpuCoreRatio).toBe(2);
      expect(health?.cpuBreakdown?.workerCoreRatio).toBeUndefined();
      if (action === "timeout") {
        now += 101;
        await clock.advanceTo(now);
      } else if (action === "worker churn") {
        revision++;
      } else {
        monitor[action]();
      }
      slow.resolve({ user: now * 500, system: 0 });
      await setImmediate();
      if (action === "timeout" || action === "worker churn") {
        expect(monitor.snapshot()).toBe(health);
        await sample();
        expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBeUndefined();
      } else {
        expect(monitor.snapshot()).toBeUndefined();
      }
      if (action === "stop") {
        expect(clock.armedAtMs).toBeNull();
      } else {
        await sample();
        expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBe(0.5);
      }
    },
  );
});

describe("Linux host CPU sampling", () => {
  let stat: string;
  let online: string;
  let readFailure: Error | undefined;
  const readStat = (buffer: NodeJS.ArrayBufferView) => {
    if (readFailure) {
      const error = readFailure;
      readFailure = undefined;
      throw error;
    }
    return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).write(stat);
  };
  const holdNextHostRead = () => {
    const held = createDeferredCore();
    hostFs.read.mockImplementationOnce(async (buffer) => {
      const bytesRead = readStat(buffer);
      await held.promise;
      return { bytesRead, buffer };
    });
    return held;
  };
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    stat = "cpu  100 20 30 400 900 5 800 700 60 10\ncpu0 0 0 0 0 0 0 0 0 0 0\n";
    online = "0-1,4,6-7\n";
    readFailure = undefined;
    vi.mocked(openSync).mockReset().mockReturnValue(42);
    vi.mocked(closeSync).mockReset();
    vi.mocked(readSync)
      .mockReset()
      .mockImplementation((_fd, buffer) => readStat(buffer));
    vi.mocked(readFileSync)
      .mockReset()
      .mockImplementation(() => online);
    hostFs.open
      .mockReset()
      .mockImplementation(async () => ({ read: hostFs.read, close: hostFs.close }));
    hostFs.close.mockReset().mockResolvedValue(undefined);
    hostFs.read
      .mockReset()
      .mockImplementation(async (buffer) => ({ bytesRead: readStat(buffer), buffer }));
    hostFs.readFile.mockReset().mockImplementation(async () => online);
  });

  it("reads bounded aggregate counters without collecting per-core CPU metadata", async () => {
    const monitor = await createMonitor();
    stat = "cpu  120 30 40 460 1900 15 1800 1700 70 20\ncpu0 0 0 0 0 0 0 0 0 0 0\n";
    await sample();
    // user+nice+sys+irq = 50 busy ticks; idle = 60. Ignore iowait,
    // softirq and steal; guest times are already included in user/nice.
    expect(monitor.snapshot()?.cpuBreakdown).toMatchObject({
      hostUtilization: 0.455,
      hostCpuCount: 5,
    });
    expect(cpus).not.toHaveBeenCalled();
    expect(vi.mocked(openSync).mock.calls.length + hostFs.open.mock.calls.length).toBe(2);
    expect(vi.mocked(closeSync).mock.calls.length + hostFs.close.mock.calls.length).toBe(2);
    expect(vi.mocked(readSync).mock.calls.length + hostFs.read.mock.calls.length).toBe(2);
    expect(vi.mocked(readFileSync).mock.calls.length + hostFs.readFile.mock.calls.length).toBe(2);
    const readSizes = [
      ...vi.mocked(readSync).mock.calls.map(([, buffer]) => buffer.byteLength),
      ...hostFs.read.mock.calls.map(([buffer]) => buffer.byteLength),
    ];
    for (const size of readSizes) {
      expect(size).toBeLessThanOrEqual(256);
    }
    // Both transports above serve valid data; only main-thread synchronous calls are forbidden.
    expect([
      vi.mocked(openSync).mock.calls.length,
      vi.mocked(readSync).mock.calls.length,
      vi.mocked(closeSync).mock.calls.length,
      vi.mocked(readFileSync).mock.calls.length,
    ]).toEqual([0, 0, 0, 0]);
  });

  it("matches per-core utilization on recorded 128-core Linux samples within rounding", async () => {
    online = "0-127\n";
    // Recorded /proc/stat aggregate rows, one second apart. Summing the
    // corresponding per-core deltas gives user=114, nice=16, sys=86,
    // idle=12571, irq=0: 216 / 12787 = 0.017 after diagnostic rounding.
    // The kernel rounds aggregate and individual-core ticks separately.
    stat = "cpu  298164289 127260169 341723678 9996274020 45356420 0 785276 0 0 0\n";
    const monitor = await createMonitor();
    stat = "cpu  298164402 127260185 341723768 9996286597 45356428 0 785276 0 0 0\n";
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown).toMatchObject({
      hostUtilization: 0.017,
      hostCpuCount: 128,
    });
  });

  it.each([
    "truncated",
    "wrong label",
    "invalid ticks",
    "rollback",
    "no ticks",
    "topology",
    "read failure",
  ])("omits unavailable utilization after %s and recovers on fresh samples", async (failure) => {
    const monitor = await createMonitor();
    if (failure === "truncated") {
      stat = "cpu 100 20 30";
    }
    if (failure === "wrong label") {
      stat = "cpu0 100 20 30 400 900 5\n";
    }
    if (failure === "invalid ticks") {
      stat = "cpu  NaN 20 30 400 900 5\n";
    }
    if (failure === "rollback") {
      stat = "cpu  99 20 30 400 900 5\n";
    }
    if (failure === "topology") {
      online = "0-3\n";
    }
    if (failure === "read failure") {
      readFailure = new Error("unavailable");
    }
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.hostUtilization).toBeUndefined();
    expect(vi.mocked(closeSync).mock.calls.length + hostFs.close.mock.calls.length).toBe(2);
    stat = "cpu  200 30 40 500 900 15\n";
    await sample();
    stat = "cpu  220 40 50 560 1900 25\n";
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.hostUtilization).toBe(0.455);
  });

  it("keeps host IO bounded through timeout, reset and stop without delaying health", async () => {
    const monitor = await createMonitor();
    const pending: Array<ReturnType<typeof holdNextHostRead>> = [];
    try {
      const timedOut = holdNextHostRead();
      pending.push(timedOut);
      stat = "cpu  120 30 40 460 1900 15\n";
      await sample();
      const health = monitor.snapshot();
      expect(health).toMatchObject({ cpuCoreRatio: 2, intervalMs: 1_000 });
      expect(health?.cpuBreakdown?.hostCpuCount).toBeUndefined();
      expect(clock.armedAtMs).toBe(now + 1_000);
      now += 101;
      await clock.advanceTo(now);
      timedOut.resolve();
      await setImmediate();
      expect(monitor.snapshot()).toBe(health);
      stat = "cpu  200 30 40 500 900 15\n";
      await sample(899);
      expect(monitor.snapshot()?.cpuBreakdown?.hostCpuCount).toBe(5);
      expect(monitor.snapshot()?.cpuBreakdown?.hostUtilization).toBeUndefined();
      stat = "cpu  220 40 50 560 1900 25\n";
      await sample();
      expect(monitor.snapshot()?.cpuBreakdown?.hostUtilization).toBe(0.455);

      const resetRead = holdNextHostRead();
      pending.push(resetRead);
      await sample();
      const opens = hostFs.open.mock.calls.length;
      await sample();
      expect(monitor.snapshot()).toMatchObject({ cpuCoreRatio: 2, intervalMs: 1_000 });
      expect(hostFs.open).toHaveBeenCalledTimes(opens);
      monitor.reset();
      expect(monitor.snapshot()).toBeUndefined();
      expect(hostFs.open).toHaveBeenCalledTimes(opens);
      await sample();
      const afterReset = monitor.snapshot();
      expect(afterReset).toMatchObject({ cpuCoreRatio: 2, intervalMs: 1_000 });
      expect(afterReset?.cpuBreakdown?.hostCpuCount).toBeUndefined();
      expect(hostFs.open).toHaveBeenCalledTimes(opens);
      resetRead.resolve();
      await setImmediate();
      expect(monitor.snapshot()).toBe(afterReset);
      stat = "cpu  300 50 60 600 1900 35\n";
      await sample();
      expect(monitor.snapshot()?.cpuBreakdown?.hostCpuCount).toBe(5);
      expect(monitor.snapshot()?.cpuBreakdown?.hostUtilization).toBeUndefined();

      const stoppedRead = holdNextHostRead();
      pending.push(stoppedRead);
      await sample();
      const opensBeforeStop = hostFs.open.mock.calls.length;
      monitor.stop();
      expect(clock.armedAtMs).toBeNull();
      expect(monitor.snapshot()).toBeUndefined();
      stoppedRead.resolve();
      await setImmediate();
      expect(monitor.snapshot()).toBeUndefined();
      expect(hostFs.open).toHaveBeenCalledTimes(opensBeforeStop);
      expect(hostFs.close).toHaveBeenCalledTimes(opensBeforeStop);
    } finally {
      for (const held of pending) {
        held.resolve();
      }
      await setImmediate();
    }
  });

  it("merges host and worker counters in either completion order", async () => {
    const monitor = await createMonitor();
    const finish: Array<() => void> = [];
    try {
      const hostFirst = holdNextHostRead();
      finish.push(() => hostFirst.resolve());
      const lateWorker = createDeferredCore<NodeJS.CpuUsage>();
      finish.push(() => lateWorker.resolve({ user: now * 500, system: 0 }));
      workerUsage.mockReturnValueOnce(lateWorker.promise);
      stat = "cpu  120 30 40 460 1900 15\n";
      await sample();
      expect(monitor.snapshot()?.cpuBreakdown).toEqual({ mainThreadCoreRatio: 0.25 });
      hostFirst.resolve();
      await setImmediate();
      expect(monitor.snapshot()?.cpuBreakdown).toEqual({
        mainThreadCoreRatio: 0.25,
        hostUtilization: 0.455,
        hostCpuCount: 5,
      });
      lateWorker.resolve({ user: now * 500, system: 0 });
      await setImmediate();
      expect(monitor.snapshot()?.cpuBreakdown).toEqual({
        mainThreadCoreRatio: 0.25,
        hostUtilization: 0.455,
        hostCpuCount: 5,
        workerCoreRatio: 0.5,
        otherThreadsCoreRatio: 1.25,
      });

      const lateHost = holdNextHostRead();
      finish.push(() => lateHost.resolve());
      const workerFirst = createDeferredCore<NodeJS.CpuUsage>();
      finish.push(() => workerFirst.resolve({ user: now * 500, system: 0 }));
      workerUsage.mockReturnValueOnce(workerFirst.promise);
      stat = "cpu  140 40 50 520 1900 25\n";
      await sample();
      workerFirst.resolve({ user: now * 500, system: 0 });
      await setImmediate();
      expect(monitor.snapshot()?.cpuBreakdown).toEqual({
        mainThreadCoreRatio: 0.25,
        workerCoreRatio: 0.5,
        otherThreadsCoreRatio: 1.25,
      });
      lateHost.resolve();
      await setImmediate();
      expect(monitor.snapshot()?.cpuBreakdown).toEqual({
        mainThreadCoreRatio: 0.25,
        hostUtilization: 0.455,
        hostCpuCount: 5,
        workerCoreRatio: 0.5,
        otherThreadsCoreRatio: 1.25,
      });
    } finally {
      for (const release of finish) {
        release();
      }
      await setImmediate();
    }
  });
});
