import { Worker } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Native exit, not pool retirement or Gateway reset, ends CPU-counter ownership.
// Shared chunks must see the same workers; this registry never starts a sampler.
const trackedWorkers = resolveGlobalSingleton(Symbol.for("openclaw.workerCpuSources"), () => ({
  revision: 0,
  workers: new Map<Worker, { cpuUsage: () => Promise<NodeJS.CpuUsage | undefined> }>(),
}));

export function createCpuTrackedWorker(...args: ConstructorParameters<typeof Worker>): Worker {
  const worker = new Worker(...args);
  let pending = false;
  trackedWorkers.workers.set(worker, {
    async cpuUsage() {
      // Worker.cpuUsage cannot cancel an interrupt blocked in native work. Keep
      // at most one outstanding request even across sampler resets/restarts.
      if (pending) {
        return undefined;
      }
      pending = true;
      try {
        return await worker.cpuUsage();
      } catch {
        return undefined;
      } finally {
        pending = false;
      }
    },
  });
  trackedWorkers.revision++;
  worker.once("exit", () => {
    trackedWorkers.workers.delete(worker);
    trackedWorkers.revision++;
  });
  return worker;
}

export function getTrackedWorkerCpuSources(): {
  revision: number;
  workers: { cpuUsage: () => Promise<NodeJS.CpuUsage | undefined> }[];
} {
  return { revision: trackedWorkers.revision, workers: [...trackedWorkers.workers.values()] };
}
