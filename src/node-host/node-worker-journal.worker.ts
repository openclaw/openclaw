import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import { NodeWorkerPreparedWorkspaceKernel } from "./node-worker-prepared-workspace-store.kernel.js";
import { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

export const nodeWorkerJournalOperations = {
  "nodeWorker.prepared.find": (
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["find"]>,
    { stateOptions },
  ) => new NodeWorkerPreparedWorkspaceKernel(stateOptions()).find(...input),
  "nodeWorker.prepared.list": (
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["list"]>,
    { stateOptions },
  ) => new NodeWorkerPreparedWorkspaceKernel(stateOptions()).list(...input),
  "nodeWorker.prepared.register": (
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["register"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerPreparedWorkspaceKernel({ ...stateOptions(), database: open() }).register(
      ...input,
    ),
  "nodeWorker.prepared.bind": (
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["bind"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerPreparedWorkspaceKernel({ ...stateOptions(), database: open() }).bind(...input),
  "nodeWorker.prepared.retire": (
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["retire"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerPreparedWorkspaceKernel({ ...stateOptions(), database: open() }).retire(...input),
  "nodeWorker.prepared.completeMutation": (
    input: Parameters<NodeWorkerPreparedWorkspaceKernel["completeMutation"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerPreparedWorkspaceKernel({ ...stateOptions(), database: open() }).completeMutation(
      ...input,
    ),
  "nodeWorker.launch.claimObservation": (
    input: Parameters<NodeWorkerLaunchKernel["claimObservation"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).claimObservation(...input),
  "nodeWorker.launch.claim": (
    input: Parameters<NodeWorkerLaunchKernel["claim"]>,
    { stateOptions, open },
  ) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).claim(...input),
  "nodeWorker.launch.listNonterminal": (
    input: Parameters<NodeWorkerLaunchKernel["listNonterminal"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).listNonterminal(...input),
  "nodeWorker.launch.nonterminalCount": (
    input: Parameters<NodeWorkerLaunchKernel["nonterminalCount"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).nonterminalCount(...input),
  "nodeWorker.launch.pruneExpiredTerminal": (
    input: Parameters<NodeWorkerLaunchKernel["pruneExpiredTerminal"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).pruneExpiredTerminal(
      ...input,
    ),
  "nodeWorker.launch.get": (
    input: Parameters<NodeWorkerLaunchKernel["get"]>,
    { stateOptions, open },
  ) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).get(...input),
  "nodeWorker.launch.getMatching": (
    input: Parameters<NodeWorkerLaunchKernel["getMatching"]>,
    { stateOptions, open },
  ) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).getMatching(...input),
  "nodeWorker.launch.cleanupBinding": (
    input: Parameters<NodeWorkerLaunchKernel["cleanupBinding"]>,
    { stateOptions, open },
  ) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).cleanupBinding(...input),
  "nodeWorker.launch.finishCancelled": (
    input: Parameters<NodeWorkerLaunchKernel["finishCancelled"]>,
    { stateOptions, open },
  ) =>
    new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).finishCancelled(...input),
  "nodeWorker.launch.markRunning": (
    input: Parameters<NodeWorkerLaunchKernel["markRunning"]>,
    { stateOptions, open },
  ) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).markRunning(...input),
  "nodeWorker.launch.finish": (
    input: Parameters<NodeWorkerLaunchKernel["finish"]>,
    { stateOptions, open },
  ) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }).finish(...input),
  "nodeWorker.turn.claim": (
    input: Parameters<NodeWorkerTurnKernel["claim"]>,
    { stateOptions, open },
  ) => new NodeWorkerTurnKernel({ ...stateOptions(), database: open() }).claim(...input),
  "nodeWorker.turn.get": (input: Parameters<NodeWorkerTurnKernel["get"]>, { stateOptions, open }) =>
    new NodeWorkerTurnKernel({ ...stateOptions(), database: open() }).get(...input),
  "nodeWorker.turn.finish": (
    input: Parameters<NodeWorkerTurnKernel["finish"]>,
    { stateOptions, open },
  ) => new NodeWorkerTurnKernel({ ...stateOptions(), database: open() }).finish(...input),
} satisfies WorkerOperationHandlers;
