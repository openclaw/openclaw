import type { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type {
  NodeWorkerJournalAuthority,
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchClaimResult,
} from "./node-worker-journal.types.js";
import type { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";

export type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchReceipt,
  NodeWorkerTerminalState,
} from "./node-worker-launch-receipt.js";
export type {
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchClaimResult,
} from "./node-worker-journal.types.js";

/** Durable launch operations on the canonical shared-state worker. */
export class NodeWorkerLaunchStore {
  constructor(private readonly worker: NodeWorkerJournalWorker) {}

  claim(
    claim: NodeWorkerLaunchClaim,
    supervisor: NodeWorkerProcessIdentity,
    capacity: number,
    nowMs = Date.now(),
    authority?: NodeWorkerJournalAuthority,
  ): Promise<NodeWorkerLaunchClaimResult> {
    const prepared = structuredClone({ claim, supervisor, capacity, nowMs });
    return this.worker.run(async (scope) => {
      const observed = await scope.execute({
        type: "nodeWorker.launch.claimObservation",
        input: [prepared.claim, prepared.supervisor, prepared.capacity, prepared.nowMs],
      });
      if (observed && observed.plan_hash !== prepared.claim.planHash) {
        throw new Error(
          `node worker launch ${prepared.claim.launchId} was replayed with a different plan`,
        );
      }
      authority?.assertCurrent();
      // Inspect the host process outside SQLite; claim rereads this exact tuple.
      const observedSupervisorState = observed
        ? inspectNodeWorkerProcessIdentity({
            pid: observed.supervisor_pid,
            startTime: observed.supervisor_start_time,
          })
        : undefined;
      return scope.execute({
        type: "nodeWorker.launch.claim",
        input: [
          prepared.claim,
          prepared.supervisor,
          prepared.capacity,
          prepared.nowMs,
          observed,
          observedSupervisorState,
        ],
      });
    }, authority);
  }

  listNonterminal(
    ...params: Parameters<NodeWorkerLaunchKernel["listNonterminal"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["listNonterminal"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.listNonterminal", input: params });
  }

  nonterminalCount(
    ...params: Parameters<NodeWorkerLaunchKernel["nonterminalCount"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["nonterminalCount"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.nonterminalCount", input: params });
  }

  pruneExpiredTerminal(
    ...params: Parameters<NodeWorkerLaunchKernel["pruneExpiredTerminal"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["pruneExpiredTerminal"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.pruneExpiredTerminal", input: params });
  }

  get(
    ...params: Parameters<NodeWorkerLaunchKernel["get"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["get"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.get", input: params });
  }

  getMatching(
    ...params: Parameters<NodeWorkerLaunchKernel["getMatching"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["getMatching"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.getMatching", input: params });
  }

  cleanupBinding(
    ...params: Parameters<NodeWorkerLaunchKernel["cleanupBinding"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["cleanupBinding"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.cleanupBinding", input: params });
  }

  finishCancelled(
    ...params: Parameters<NodeWorkerLaunchKernel["finishCancelled"]>
  ): Promise<ReturnType<NodeWorkerLaunchKernel["finishCancelled"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.finishCancelled", input: params });
  }

  finish(
    params: Parameters<NodeWorkerLaunchKernel["finish"]>[0],
    authority?: NodeWorkerJournalAuthority,
  ): Promise<ReturnType<NodeWorkerLaunchKernel["finish"]>> {
    return this.worker.execute({ type: "nodeWorker.launch.finish", input: [params] }, authority);
  }

  markRunning(
    params: Parameters<NodeWorkerLaunchKernel["markRunning"]>[0],
    authority?: NodeWorkerJournalAuthority,
  ): Promise<ReturnType<NodeWorkerLaunchKernel["markRunning"]>> {
    return this.worker.execute(
      { type: "nodeWorker.launch.markRunning", input: [params] },
      authority,
    );
  }
}
