import type { NodeWorkerSupervisorIdentity } from "../worker/node-supervisor-protocol.js";
import { NodeWorkerJournalWorker } from "./node-worker-journal-worker.js";
import {
  nodeWorkerTurnMatchesIdentity,
  type NodeWorkerJournalAuthority,
  type NodeWorkerTurnReceipt,
} from "./node-worker-journal.types.js";
import type { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

export type { NodeWorkerTurnReceipt } from "./node-worker-journal.types.js";

/** Immutable turn outcomes attached to a separately supervised physical worker. */
export class NodeWorkerTurnStore {
  private readonly worker: NodeWorkerJournalWorker;

  constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
    this.worker = new NodeWorkerJournalWorker(options);
  }

  claim(
    params: Parameters<NodeWorkerTurnKernel["claim"]>[0],
    authority?: NodeWorkerJournalAuthority,
  ): Promise<ReturnType<NodeWorkerTurnKernel["claim"]>> {
    return this.worker.execute({ type: "nodeWorker.turn.claim", input: [params] }, authority);
  }

  get(turnId: string): Promise<NodeWorkerTurnReceipt | undefined> {
    return this.worker.execute({ type: "nodeWorker.turn.get", input: [turnId] });
  }

  async getMatching(
    expected: NodeWorkerSupervisorIdentity,
  ): Promise<NodeWorkerTurnReceipt | undefined> {
    const identity = { ...expected };
    const receipt = await this.get(identity.launchId);
    return receipt && nodeWorkerTurnMatchesIdentity(receipt, identity) ? receipt : undefined;
  }

  finish(
    params: Parameters<NodeWorkerTurnKernel["finish"]>[0],
  ): Promise<NodeWorkerTurnReceipt | undefined> {
    return this.worker.execute({ type: "nodeWorker.turn.finish", input: [params] });
  }

  drain(options: { close?: boolean } = {}): Promise<void> {
    return this.worker.drain(options);
  }
}
