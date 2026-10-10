import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";

/** Checkout custody outlives allocation; revoke the exact retained checkout owner. */
export function captureWorktreeMutationHeartbeat(): (worktreeId: string) => Promise<void> {
  const heartbeatUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  const createWorker = workerCpu.createCpuTrackedWorker;
  const heartbeats = new Map<string, Worker>();
  vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = createWorker(...args);
    const data: unknown = args[1]?.workerData;
    if (
      String(args[0]) === heartbeatUrl.href &&
      isRecord(data) &&
      isRecord(data.identity) &&
      data.identity.scope === WORKTREE_MUTATION_LEASE_SCOPE &&
      typeof data.identity.key === "string"
    ) {
      const id = data.identity.key;
      heartbeats.set(id, worker);
      worker.once("exit", () => {
        if (heartbeats.get(id) === worker) {
          heartbeats.delete(id);
        }
      });
    }
    return worker;
  });
  return async (worktreeId) => {
    const heartbeat = heartbeats.get(worktreeId);
    if (!heartbeat) {
      throw new Error(`Worktree mutation heartbeat is not live: ${worktreeId}`);
    }
    await heartbeat.terminate();
  };
}
