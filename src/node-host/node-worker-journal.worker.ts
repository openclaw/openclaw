import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  normalizeStoredNodeHostConfig,
  type NodeHostConfig,
  type PreparedNodeHostConfig,
} from "./config-shared.js";
import { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import { NodeWorkerPreparedWorkspaceKernel } from "./node-worker-prepared-workspace-store.kernel.js";
import { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";

function configureNodeHostInWorker(
  [input]: [PreparedNodeHostConfig],
  { write }: WorkerWriteOperationContext,
): { config: NodeHostConfig; clearedCommands: boolean } {
  return write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { kind: "node-worker-journal" },
      });
      let clearedCommands = false;
      const config = updateConfigMachineStateInDatabase<NodeHostConfig>(
        db,
        "nodeHost.config",
        (stored) => {
          const existing = stored === undefined ? undefined : normalizeStoredNodeHostConfig(stored);
          clearedCommands = input.allCommands === true && existing?.commands !== undefined;
          const commands = input.allCommands ? undefined : (input.commands ?? existing?.commands);
          return {
            version: 1,
            nodeId: input.explicitNodeId ?? existing?.nodeId ?? input.candidateNodeId,
            displayName:
              input.explicitDisplayName ?? existing?.displayName ?? input.fallbackDisplayName,
            gateway: input.gateway,
            installedAppsSharing:
              input.installedAppsSharing ?? existing?.installedAppsSharing ?? false,
            ...(commands !== undefined ? { commands } : {}),
          };
        },
        input.updatedAtMs,
      );
      return { config, clearedCommands };
    },
    { operationLabel: "node-host.configure" },
  );
}

function journalKernel<Kernel>(create: (context: WorkerOperationContext) => Kernel) {
  return <Input extends unknown[], Output>(
    select: (kernel: Kernel) => (...input: Input) => Output,
  ) =>
    (input: Input, context: WorkerOperationContext): Output =>
      select(create(context))(...input);
}

const preparedRead = journalKernel(
  ({ stateOptions }) => new NodeWorkerPreparedWorkspaceKernel(stateOptions()),
);
const preparedWrite = journalKernel(
  ({ stateOptions, open }) =>
    new NodeWorkerPreparedWorkspaceKernel({ ...stateOptions(), database: open() }),
);
const launch = journalKernel(
  ({ stateOptions, open }) => new NodeWorkerLaunchKernel({ ...stateOptions(), database: open() }),
);
const turn = journalKernel(
  ({ stateOptions, open }) => new NodeWorkerTurnKernel({ ...stateOptions(), database: open() }),
);

export const nodeWorkerJournalOperations = {
  "nodeWorker.configure": configureNodeHostInWorker,
  "nodeWorker.prepared.find": preparedRead((kernel) => kernel.find.bind(kernel)),
  "nodeWorker.prepared.list": preparedRead((kernel) => kernel.list.bind(kernel)),
  "nodeWorker.prepared.register": preparedWrite((kernel) => kernel.register.bind(kernel)),
  "nodeWorker.prepared.bind": preparedWrite((kernel) => kernel.bind.bind(kernel)),
  "nodeWorker.prepared.retire": preparedWrite((kernel) => kernel.retire.bind(kernel)),
  "nodeWorker.prepared.completeMutation": preparedWrite((kernel) =>
    kernel.completeMutation.bind(kernel),
  ),
  "nodeWorker.launch.claimObservation": launch((kernel) => kernel.claimObservation.bind(kernel)),
  "nodeWorker.launch.claim": launch((kernel) => kernel.claim.bind(kernel)),
  "nodeWorker.launch.listNonterminal": launch((kernel) => kernel.listNonterminal.bind(kernel)),
  "nodeWorker.launch.nonterminalCount": launch((kernel) => kernel.nonterminalCount.bind(kernel)),
  "nodeWorker.launch.pruneExpiredTerminal": launch((kernel) =>
    kernel.pruneExpiredTerminal.bind(kernel),
  ),
  "nodeWorker.launch.get": launch((kernel) => kernel.get.bind(kernel)),
  "nodeWorker.launch.getMatching": launch((kernel) => kernel.getMatching.bind(kernel)),
  "nodeWorker.launch.cleanupBinding": launch((kernel) => kernel.cleanupBinding.bind(kernel)),
  "nodeWorker.launch.finishCancelled": launch((kernel) => kernel.finishCancelled.bind(kernel)),
  "nodeWorker.launch.markRunning": launch((kernel) => kernel.markRunning.bind(kernel)),
  "nodeWorker.launch.finish": launch((kernel) => kernel.finish.bind(kernel)),
  "nodeWorker.turn.claim": turn((kernel) => kernel.claim.bind(kernel)),
  "nodeWorker.turn.get": turn((kernel) => kernel.get.bind(kernel)),
  "nodeWorker.turn.finish": turn((kernel) => kernel.finish.bind(kernel)),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
