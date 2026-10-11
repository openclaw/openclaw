import type { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type {
  NodeWorkerJournalAuthority,
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchClaimResult,
} from "./node-worker-journal.types.js";
import type { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import {
  getNodeWorkerBootIdentity,
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
  readonly listNonterminal;
  readonly get;
  readonly nonterminalCount;
  readonly pruneExpiredTerminal;
  readonly getMatching;
  readonly cleanupBinding;
  readonly finishCancelled;

  constructor(private readonly worker: NodeWorkerJournalWorker) {
    this.get = worker.operation("nodeWorker.launch.get");
    this.listNonterminal = worker.operation("nodeWorker.launch.listNonterminal");
    this.nonterminalCount = worker.operation("nodeWorker.launch.nonterminalCount");
    this.pruneExpiredTerminal = worker.operation("nodeWorker.launch.pruneExpiredTerminal");
    this.getMatching = worker.operation("nodeWorker.launch.getMatching");
    this.cleanupBinding = worker.operation("nodeWorker.launch.cleanupBinding");
    this.finishCancelled = worker.operation("nodeWorker.launch.finishCancelled");
  }

  claim(
    claim: NodeWorkerLaunchClaim,
    supervisor: NodeWorkerProcessIdentity,
    capacity: number,
    nowMs = Date.now(),
    authority?: NodeWorkerJournalAuthority,
  ): Promise<NodeWorkerLaunchClaimResult> {
    const prepared = structuredClone({
      claim,
      supervisor,
      capacity,
      nowMs,
      bootId: getNodeWorkerBootIdentity(),
    });
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
          prepared.bootId,
        ],
      });
    }, authority);
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
