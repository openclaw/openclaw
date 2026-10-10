import type { NodeWorkerSupervisorIdentity } from "../worker/node-supervisor-protocol.js";
import { nodeWorkerTurnMatchesIdentity } from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import type {
  NodeWorkerJournalAuthority,
  NodeWorkerTurnReceipt,
} from "./node-worker-journal.types.js";
import type { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

export type { NodeWorkerTurnReceipt } from "./node-worker-journal.types.js";

/** Immutable turn outcomes attached to a separately supervised physical worker. */
export class NodeWorkerTurnStore {
  readonly get;
  readonly finish;

  constructor(private readonly worker: NodeWorkerJournalWorker) {
    this.get = worker.operation("nodeWorker.turn.get");
    this.finish = worker.operation("nodeWorker.turn.finish");
  }

  claim(
    params: Parameters<NodeWorkerTurnKernel["claim"]>[0],
    authority?: NodeWorkerJournalAuthority,
  ): Promise<ReturnType<NodeWorkerTurnKernel["claim"]>> {
    return this.worker.execute({ type: "nodeWorker.turn.claim", input: [params] }, authority);
  }

  async getMatching(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerTurnReceipt | undefined> {
    const identity = { ...expected };
    const receipt = await this.get(identity.launchId);
    return receipt && nodeWorkerTurnMatchesIdentity(receipt, identity) ? receipt : undefined;
  }
}
