import {
  canonicalize,
  isOlderSnapshot,
  mergeFreshnessState,
} from "../../packages/openclaw-id-protocol/src/index.js";
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
  type NodeHostGatewayConfig,
  type PreparedNodeHostConfig,
} from "./config-shared.js";
import { NodeWorkerLaunchKernel } from "./node-worker-launch-store.kernel.js";
import { NodeWorkerPreparedWorkspaceKernel } from "./node-worker-prepared-workspace-store.kernel.js";
import { NodeWorkerTurnKernel } from "./node-worker-turn-store.kernel.js";
import {
  sameNodeHostOpenClawIdIdentity,
  sameNodeHostOpenClawIdScope,
  type NodeHostOpenClawIdTarget,
} from "./openclaw-id-target.js";

/** Trust advances independently of startup endpoint selection and display/command updates. */
function mergeTargetTrust(
  current: NodeHostOpenClawIdTarget,
  candidate: NodeHostOpenClawIdTarget,
): NodeHostOpenClawIdTarget {
  if (
    current.pin.binding_seq === candidate.pin.binding_seq &&
    canonicalize(current.evidence.binding.body) !== canonicalize(candidate.evidence.binding.body)
  ) {
    throw new Error("OpenClaw ID has conflicting bindings at the same sequence");
  }
  const binding = current.pin.binding_seq > candidate.pin.binding_seq ? current : candidate;
  const freshness = candidate.freshness
    ? mergeFreshnessState(current.freshness, candidate.freshness)
    : current.freshness;
  return { ...binding, ...(freshness ? { freshness } : {}) };
}

function mergeGatewayTrust(
  current: NodeHostGatewayConfig | undefined,
  candidate: NodeHostGatewayConfig | undefined,
): NodeHostGatewayConfig | undefined {
  if (
    current?.kind !== "openclaw-id" ||
    candidate?.kind !== "openclaw-id" ||
    !current.openclawId ||
    !candidate.openclawId ||
    !sameNodeHostOpenClawIdIdentity(current.openclawId, candidate.openclawId)
  ) {
    return candidate;
  }
  return {
    kind: "openclaw-id",
    openclawId: {
      ...mergeTargetTrust(current.openclawId, candidate.openclawId),
      relayUrl: candidate.openclawId.relayUrl,
      discoveryUrl: candidate.openclawId.discoveryUrl,
    },
  };
}

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
            gateway: mergeGatewayTrust(existing?.gateway, input.gateway),
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

function refreshNodeHostOpenClawIdTargetInWorker(
  [input]: [
    {
      nodeId: string;
      expected: NodeHostOpenClawIdTarget;
      target: NodeHostOpenClawIdTarget;
      updatedAtMs: number;
    },
  ],
  { write }: WorkerWriteOperationContext,
): { target: NodeHostOpenClawIdTarget; superseded: boolean } {
  return write(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { kind: "node-worker-journal" },
      });
      const result = { target: input.target, superseded: false };
      updateConfigMachineStateInDatabase<NodeHostConfig>(
        db,
        "nodeHost.config",
        (stored) => {
          const existing = stored === undefined ? undefined : normalizeStoredNodeHostConfig(stored);
          const current = existing?.gateway?.openclawId;
          if (
            !existing ||
            existing.nodeId !== input.nodeId ||
            existing.gateway?.kind !== "openclaw-id" ||
            !current ||
            !sameNodeHostOpenClawIdScope(current, input.expected) ||
            !sameNodeHostOpenClawIdScope(current, input.target)
          ) {
            throw new Error("OpenClaw ID node configuration changed during refresh");
          }
          const target = mergeTargetTrust(current, input.target);
          result.target = target;
          result.superseded =
            target.pin.binding_seq > input.target.pin.binding_seq ||
            Boolean(
              target.freshness?.snapshot &&
              (!input.target.freshness?.snapshot ||
                isOlderSnapshot(input.target.freshness.snapshot, target.freshness.snapshot) ||
                input.target.freshness.snapshot.binding_seq <
                  target.freshness.snapshot.binding_seq),
            );
          return {
            ...existing,
            gateway: { kind: "openclaw-id", openclawId: target },
          };
        },
        input.updatedAtMs,
      );
      return result;
    },
    { operationLabel: "node-host.refresh-openclaw-id-target" },
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
  "nodeWorker.refreshOpenClawIdTarget": refreshNodeHostOpenClawIdTargetInWorker,
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
