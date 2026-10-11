import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import {
  normalizeStoredNodeHostConfig,
  type NodeHostConfig,
  type PreparedNodeHostConfig,
} from "./config-shared.js";

export function configureNodeHostInWorker(
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
