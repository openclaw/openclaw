import type { NodeWorkerSupervisorIdentity } from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerLaunchReceipt, NodeWorkerLaunchRow } from "./node-worker-launch-receipt.js";
import type { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

export type NodeWorkerLaunchClaim = Pick<
  NodeWorkerLaunchReceipt,
  | "environmentId"
  | "gatewayNamespace"
  | "launchId"
  | "ownerEpoch"
  | "placementGeneration"
  | "planHash"
  | "runId"
  | "sessionId"
>;

export type NodeWorkerLaunchClaimResult =
  | {
      action: "start" | "replay" | "recover";
      receipt: NodeWorkerLaunchReceipt;
      nonterminalCount: number;
    }
  | {
      action: "at-capacity";
      nonterminalCount: number;
    };

export type NodeWorkerTurnReceipt = NodeWorkerLaunchReceipt & { ownerLaunchId: string };

export type NodeWorkerLaunchObservation = Pick<
  NodeWorkerLaunchRow,
  | "plan_hash"
  | "state"
  | "supervisor_pid"
  | "supervisor_start_time"
  | "worker_pid"
  | "worker_start_time"
>;

export type NodeWorkerLaunchObservedSupervisorState = ReturnType<
  typeof inspectNodeWorkerProcessIdentity
>;

export type NodeWorkerJournalAuthority = {
  assertCurrent(): void;
};

export function nodeWorkerTurnMatchesIdentity(
  receipt: NodeWorkerSupervisorIdentity,
  expected: NodeWorkerSupervisorIdentity,
): boolean {
  return (
    receipt.launchId === expected.launchId &&
    receipt.planHash === expected.planHash &&
    receipt.environmentId === expected.environmentId &&
    receipt.sessionId === expected.sessionId &&
    receipt.ownerEpoch === expected.ownerEpoch &&
    receipt.placementGeneration === expected.placementGeneration &&
    receipt.runId === expected.runId
  );
}
