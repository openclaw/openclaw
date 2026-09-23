import { cpus } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTrackedWorkerCpuSources } from "../../infra/worker-cpu.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createGatewayEventLoopHealthMonitor } from "./event-loop-health.js";

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
let revision = 0;
let workers: ReturnType<typeof getTrackedWorkerCpuSources>["workers"];
const workerUsage = vi.fn<() => Promise<NodeJS.CpuUsage | undefined>>();
const mainThreadUsage = vi.fn<() => NodeJS.CpuUsage>();

function hostCpu(user: number, idle: number) {
  return { model: "test", speed: 1, times: { user, idle, nice: 0, sys: 0, irq: 0 } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  now = 10_000;
  revision = 0;
  workers = [{ cpuUsage: workerUsage }];
  workerUsage.mockReset().mockImplementation(async () => ({ user: now * 500, system: 0 }));
  vi.mocked(getTrackedWorkerCpuSources).mockImplementation(() => ({ workers, revision }));
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
  vi.useRealTimers();
});

async function createMonitor() {
  const monitor = createGatewayEventLoopHealthMonitor({
    now: () => now,
    cpuUsage: (previous) => ({ user: now * 2_000 - (previous?.user ?? 0), system: 0 }),
    eventLoopUtilization: () => ({ idle: now, active: 0, utilization: 0.05 }),
  });
  monitors.push(monitor);
  await vi.advanceTimersByTimeAsync(0);
  return monitor;
}

async function sample(elapsedMs = 1_000) {
  now += elapsedMs;
  await vi.advanceTimersByTimeAsync(20);
}

describe("CPU breakdown sampling", () => {
  it("measures host, main and tracked workers independently without changing process units", async () => {
    const monitor = await createMonitor();
    expect(monitor.snapshot()).toBeUndefined();
    await sample();
    expect(monitor.snapshot()).toMatchObject({
      cpuCoreRatio: 2,
      utilization: 0.05,
      cpuBreakdown: {
        mainThreadCoreRatio: 0.25,
        workerCoreRatio: 0.5,
        otherThreadsCoreRatio: 1.25,
        hostUtilization: 0.75,
        hostCpuCount: 2,
      },
    });
    const snapshot = monitor.snapshot();
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
    workerUsage.mockRejectedValue(new Error("worker exited"));
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

  it("times out slow worker capture without delaying process samples or accepting late results", async () => {
    const monitor = await createMonitor();
    const slow = createDeferredCore<NodeJS.CpuUsage>();
    workerUsage.mockReturnValueOnce(slow.promise);
    await sample();
    const health = monitor.snapshot();
    expect(health?.cpuCoreRatio).toBe(2);
    expect(health?.cpuBreakdown?.workerCoreRatio).toBeUndefined();
    await vi.advanceTimersByTimeAsync(101);
    slow.resolve({ user: now * 500, system: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.snapshot()).toBe(health);
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBeUndefined();
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBe(0.5);
  });

  it.each(["reset", "stop"] as const)(
    "fences pending replies and releases timers on %s",
    async (action) => {
      const monitor = await createMonitor();
      const slow = createDeferredCore<NodeJS.CpuUsage>();
      workerUsage.mockReturnValueOnce(slow.promise);
      await sample();
      monitor[action]();
      slow.resolve({ user: now * 500, system: 0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.snapshot()).toBeUndefined();
      if (action === "stop") {
        expect(vi.getTimerCount()).toBe(0);
      } else {
        await sample();
        expect(monitor.snapshot()?.cpuBreakdown?.workerCoreRatio).toBe(0.5);
      }
    },
  );

  it("omits unreliable Bun worker counters while retaining independent host and main counters", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun: "1.4.2" } });
    const monitor = await createMonitor();
    await sample();
    expect(monitor.snapshot()?.cpuBreakdown).toEqual({
      mainThreadCoreRatio: 0.25,
      hostUtilization: 0.75,
      hostCpuCount: 2,
    });
    expect(workerUsage).not.toHaveBeenCalled();
  });
});
