import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import type { NodeWorkerPreparedWorkspaceKernel } from "./node-worker-prepared-workspace-store.kernel.js";
import type { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

type KernelWorkerOperations<Prefix extends string, Kernel> = {
  [Method in keyof Kernel & string as `${Prefix}.${Method}`]: Kernel[Method] extends (
    ...input: infer Input
  ) => infer Output
    ? { input: Input; output: Output }
    : never;
};

export type NodeWorkerJournalWorkerOperations = KernelWorkerOperations<
  "nodeWorker.prepared",
  NodeWorkerPreparedWorkspaceKernel
> &
  KernelWorkerOperations<"nodeWorker.launch", NodeWorkerLaunchKernel> &
  KernelWorkerOperations<"nodeWorker.turn", NodeWorkerTurnKernel>;

export function isNodeWorkerJournalCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<NodeWorkerJournalWorkerOperations> {
  return Object.hasOwn(nodeWorkerJournalCommands, command.type);
}

const nodeWorkerJournalCommands = {
  "nodeWorker.prepared.find": true,
  "nodeWorker.prepared.list": true,
  "nodeWorker.prepared.register": true,
  "nodeWorker.prepared.bind": true,
  "nodeWorker.prepared.retire": true,
  "nodeWorker.prepared.completeMutation": true,

  "nodeWorker.launch.claimObservation": true,
  "nodeWorker.launch.claim": true,
  "nodeWorker.launch.listNonterminal": true,
  "nodeWorker.launch.nonterminalCount": true,
  "nodeWorker.launch.pruneExpiredTerminal": true,
  "nodeWorker.launch.get": true,
  "nodeWorker.launch.getMatching": true,
  "nodeWorker.launch.cleanupBinding": true,
  "nodeWorker.launch.finishCancelled": true,
  "nodeWorker.launch.markRunning": true,
  "nodeWorker.launch.finish": true,
  "nodeWorker.turn.claim": true,
  "nodeWorker.turn.get": true,
  "nodeWorker.turn.finish": true,
} satisfies Record<keyof NodeWorkerJournalWorkerOperations, true>;
