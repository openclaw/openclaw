import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { NodeWorkerJournalWorkerOperations } from "./node-worker-journal.worker-contract.js";
import { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import { NodeWorkerPreparedWorkspaceKernel } from "./node-worker-prepared-workspace-store.kernel.js";
import { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

export function executeNodeWorkerJournalCommand(
  command: SqliteWorkerCommand<NodeWorkerJournalWorkerOperations>,
  databasePath: string,
  open: () => NonNullable<OpenClawStateDatabaseOptions["database"]>,
): NodeWorkerJournalWorkerOperations[keyof NodeWorkerJournalWorkerOperations]["output"] {
  const contextOptions = {
    path: databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  if (command.type === "nodeWorker.prepared.find") {
    return new NodeWorkerPreparedWorkspaceKernel(contextOptions).find(...command.input);
  }
  if (command.type === "nodeWorker.prepared.list") {
    return new NodeWorkerPreparedWorkspaceKernel(contextOptions).list(...command.input);
  }
  const options = { ...contextOptions, database: open() };
  switch (command.type) {
    case "nodeWorker.prepared.register":
      return new NodeWorkerPreparedWorkspaceKernel(options).register(...command.input);
    case "nodeWorker.prepared.bind":
      return new NodeWorkerPreparedWorkspaceKernel(options).bind(...command.input);
    case "nodeWorker.prepared.retire":
      return new NodeWorkerPreparedWorkspaceKernel(options).retire(...command.input);
    case "nodeWorker.prepared.completeMutation":
      return new NodeWorkerPreparedWorkspaceKernel(options).completeMutation(...command.input);

    case "nodeWorker.launch.claimObservation":
      return new NodeWorkerLaunchKernel(options).claimObservation(...command.input);
    case "nodeWorker.launch.claim":
      return new NodeWorkerLaunchKernel(options).claim(...command.input);
    case "nodeWorker.launch.listNonterminal":
      return new NodeWorkerLaunchKernel(options).listNonterminal(...command.input);
    case "nodeWorker.launch.nonterminalCount":
      return new NodeWorkerLaunchKernel(options).nonterminalCount(...command.input);
    case "nodeWorker.launch.pruneExpiredTerminal":
      return new NodeWorkerLaunchKernel(options).pruneExpiredTerminal(...command.input);
    case "nodeWorker.launch.get":
      return new NodeWorkerLaunchKernel(options).get(...command.input);
    case "nodeWorker.launch.getMatching":
      return new NodeWorkerLaunchKernel(options).getMatching(...command.input);
    case "nodeWorker.launch.cleanupBinding":
      return new NodeWorkerLaunchKernel(options).cleanupBinding(...command.input);
    case "nodeWorker.launch.finishCancelled":
      return new NodeWorkerLaunchKernel(options).finishCancelled(...command.input);
    case "nodeWorker.launch.markRunning":
      return new NodeWorkerLaunchKernel(options).markRunning(...command.input);
    case "nodeWorker.launch.finish":
      return new NodeWorkerLaunchKernel(options).finish(...command.input);
    case "nodeWorker.turn.claim":
      return new NodeWorkerTurnKernel(options).claim(...command.input);
    case "nodeWorker.turn.get":
      return new NodeWorkerTurnKernel(options).get(...command.input);
    case "nodeWorker.turn.finish":
      return new NodeWorkerTurnKernel(options).finish(...command.input);
  }
  throw new Error("Unsupported node worker journal command");
}
