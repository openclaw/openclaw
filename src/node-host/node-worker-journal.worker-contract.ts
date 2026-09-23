import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import type { NodeWorkerPreparedWorkspaceKernel } from "./node-worker-prepared-workspace-store.kernel.js";
import type { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

export type NodeWorkerJournalWorkerOperations = {
  "nodeWorker.prepared.find": {
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["find"]>;
    output: ReturnType<NodeWorkerPreparedWorkspaceKernel["find"]>;
  };
  "nodeWorker.prepared.list": {
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["list"]>;
    output: ReturnType<NodeWorkerPreparedWorkspaceKernel["list"]>;
  };
  "nodeWorker.prepared.register": {
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["register"]>;
    output: ReturnType<NodeWorkerPreparedWorkspaceKernel["register"]>;
  };
  "nodeWorker.prepared.bind": {
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["bind"]>;
    output: ReturnType<NodeWorkerPreparedWorkspaceKernel["bind"]>;
  };
  "nodeWorker.prepared.retire": {
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["retire"]>;
    output: ReturnType<NodeWorkerPreparedWorkspaceKernel["retire"]>;
  };
  "nodeWorker.prepared.completeMutation": {
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["completeMutation"]>;
    output: ReturnType<NodeWorkerPreparedWorkspaceKernel["completeMutation"]>;
  };

  "nodeWorker.launch.claimObservation": {
    input: Parameters<NodeWorkerLaunchKernel["claimObservation"]>;
    output: ReturnType<NodeWorkerLaunchKernel["claimObservation"]>;
  };
  "nodeWorker.launch.claim": {
    input: Parameters<NodeWorkerLaunchKernel["claim"]>;
    output: ReturnType<NodeWorkerLaunchKernel["claim"]>;
  };
  "nodeWorker.launch.listNonterminal": {
    input: Parameters<NodeWorkerLaunchKernel["listNonterminal"]>;
    output: ReturnType<NodeWorkerLaunchKernel["listNonterminal"]>;
  };
  "nodeWorker.launch.nonterminalCount": {
    input: Parameters<NodeWorkerLaunchKernel["nonterminalCount"]>;
    output: ReturnType<NodeWorkerLaunchKernel["nonterminalCount"]>;
  };
  "nodeWorker.launch.pruneExpiredTerminal": {
    input: Parameters<NodeWorkerLaunchKernel["pruneExpiredTerminal"]>;
    output: ReturnType<NodeWorkerLaunchKernel["pruneExpiredTerminal"]>;
  };
  "nodeWorker.launch.get": {
    input: Parameters<NodeWorkerLaunchKernel["get"]>;
    output: ReturnType<NodeWorkerLaunchKernel["get"]>;
  };
  "nodeWorker.launch.getMatching": {
    input: Parameters<NodeWorkerLaunchKernel["getMatching"]>;
    output: ReturnType<NodeWorkerLaunchKernel["getMatching"]>;
  };
  "nodeWorker.launch.cleanupBinding": {
    input: Parameters<NodeWorkerLaunchKernel["cleanupBinding"]>;
    output: ReturnType<NodeWorkerLaunchKernel["cleanupBinding"]>;
  };
  "nodeWorker.launch.finishCancelled": {
    input: Parameters<NodeWorkerLaunchKernel["finishCancelled"]>;
    output: ReturnType<NodeWorkerLaunchKernel["finishCancelled"]>;
  };
  "nodeWorker.launch.markRunning": {
    input: Parameters<NodeWorkerLaunchKernel["markRunning"]>;
    output: ReturnType<NodeWorkerLaunchKernel["markRunning"]>;
  };
  "nodeWorker.launch.finish": {
    input: Parameters<NodeWorkerLaunchKernel["finish"]>;
    output: ReturnType<NodeWorkerLaunchKernel["finish"]>;
  };
  "nodeWorker.turn.claim": {
    input: Parameters<NodeWorkerTurnKernel["claim"]>;
    output: ReturnType<NodeWorkerTurnKernel["claim"]>;
  };
  "nodeWorker.turn.get": {
    input: Parameters<NodeWorkerTurnKernel["get"]>;
    output: ReturnType<NodeWorkerTurnKernel["get"]>;
  };
  "nodeWorker.turn.finish": {
    input: Parameters<NodeWorkerTurnKernel["finish"]>;
    output: ReturnType<NodeWorkerTurnKernel["finish"]>;
  };
};

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
