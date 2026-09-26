import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import type { NodeWorkerTerminalOutcome } from "./node-worker-launch-observation.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import type {
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
} from "./node-worker-supervisor-contract.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

export type NodeWorkerStopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;

export type NodeWorkerEnvironmentBinding = ReturnType<typeof nodeWorkerEnvironmentBinding>;

export type NodeWorkerPendingAdmission = {
  binding: NodeWorkerEnvironmentBinding;
  launchId: string;
  planHash: string;
  identity: NodeWorkerSupervisorIdentity;
  abort: AbortController;
  signal: AbortSignal;
  done: Promise<NodeWorkerLaunchReceipt>;
};

/** Only environment facts survive a turn; descriptors contain disposable admission authority. */
export function nodeWorkerEnvironmentBinding(input: NodeWorkerLaunchInput) {
  const { admission, assignment } = input.descriptor;
  return {
    gatewayNamespace: input.gatewayNamespace,
    environmentId: admission.environmentId,
    sessionId: admission.sessionId,
    ownerEpoch: admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    bundleHash: input.expectedBundleHash,
    agentId: assignment.agentId,
    workspaceDir: assignment.workspaceDir,
    containmentRoot: assignment.workerContainmentRoot,
    permissionMode: assignment.permissionMode,
    inference: assignment.inference,
  };
}

export function nodeWorkerEnvironmentKey(
  binding: Pick<NodeWorkerEnvironmentBinding, "gatewayNamespace" | "environmentId">,
): string {
  return JSON.stringify([binding.gatewayNamespace, binding.environmentId]);
}

export function nodeWorkerEnvironmentMatches(
  binding: Pick<
    NodeWorkerEnvironmentBinding,
    "gatewayNamespace" | "environmentId" | "sessionId" | "ownerEpoch"
  >,
  expected: Pick<
    NodeWorkerEnvironmentBinding,
    "gatewayNamespace" | "environmentId" | "sessionId" | "ownerEpoch"
  >,
): boolean {
  return (
    binding.gatewayNamespace === expected.gatewayNamespace &&
    binding.environmentId === expected.environmentId &&
    binding.sessionId === expected.sessionId &&
    binding.ownerEpoch === expected.ownerEpoch
  );
}

type NodeWorkerActiveTurn = {
  claim: NodeWorkerLaunchClaim;
  done: Promise<void>;
  settle: () => void;
  cancelled: boolean;
  settling?: Promise<void>;
};

/** Retain prepared workspace custody until the admitted launch settles. */
export async function launchWithNodeWorkerPreparedWorkspace(params: {
  workspace: Pick<NodeWorkerWorkspaceRuntime, "acquirePreparedWorkspace">;
  request: Parameters<NodeWorkerWorkspaceRuntime["acquirePreparedWorkspace"]>[0];
  signal: AbortSignal;
  isCurrent: () => boolean;
  launch: (homeDir?: string) => Promise<NodeWorkerLaunchReceipt>;
}): Promise<NodeWorkerLaunchReceipt> {
  const workspace = await params.workspace.acquirePreparedWorkspace(params.request);
  try {
    params.signal.throwIfAborted();
    if (!params.isCurrent()) {
      throw new Error("node worker environment is stopping");
    }
    return await params.launch(workspace?.homeDir);
  } finally {
    workspace?.release();
  }
}

export function createNodeWorkerActiveTurn(claim: NodeWorkerLaunchClaim): NodeWorkerActiveTurn {
  const { promise, resolve } = createDeferredCore();
  return { claim, done: promise, settle: resolve, cancelled: false };
}

type NodeWorkerActiveBase = {
  binding: NodeWorkerEnvironmentBinding;
  gatewayNamespace: string;
  launchId: string;
  planHash: string;
  supervisor: NodeWorkerProcessIdentity;
  worker: NodeWorkerProcessIdentity;
  container?: NodeWorkerContainerIdentity;
};

export type NodeWorkerRunningChild = NodeWorkerActiveBase & {
  state: "running";
  adapter: NodeWorkerChildAdapter;
  done: Promise<void>;
  journalReady: Promise<void>;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
  turn?: NodeWorkerActiveTurn;
  retiring: boolean;
  stopState?: NodeWorkerStopState;
  containerCleanup?: Promise<void>;
  deferredOutcome?: NodeWorkerTerminalOutcome;
};

export type NodeWorkerObservedTerminal = NodeWorkerActiveBase & {
  state: "observed";
  outcome: NodeWorkerTerminalOutcome;
  turn?: NodeWorkerActiveTurn;
  cancelledTurn?: NodeWorkerLaunchClaim;
  reconciliation?: Promise<NodeWorkerLaunchReceipt>;
};

function createNodeWorkerObservedTerminal(
  active: NodeWorkerRunningChild,
  outcome: NodeWorkerTerminalOutcome,
): NodeWorkerObservedTerminal {
  return {
    state: "observed",
    binding: active.binding,
    gatewayNamespace: active.gatewayNamespace,
    launchId: active.launchId,
    planHash: active.planHash,
    supervisor: active.supervisor,
    worker: active.worker,
    ...(active.container ? { container: active.container } : {}),
    outcome,
    ...(active.turn ? { turn: active.turn } : {}),
    ...(!active.stopState && active.turn?.cancelled ? { cancelledTurn: active.turn.claim } : {}),
  };
}

export type NodeWorkerActiveOwnership = NodeWorkerRunningChild | NodeWorkerObservedTerminal;

export type NodeWorkerSupervisorOptions = {
  bundleRoot?: string;
  env?: NodeJS.ProcessEnv;
  capacity?: number;
  capacityWaitMs?: number;
  onCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
  workspace?: NodeWorkerWorkspaceRuntime;
  containerEngine?: NodeWorkerContainerEngine;
  containerImage?: string;
  /** Node-local trusted configuration, captured synchronously at construction. */
  nativeInferenceConfig?: string;
};

/** Match both process bookkeeping and exact authoritative container identity. */
export function nodeWorkerReceiptMatchesOwner(
  receipt: NodeWorkerLaunchReceipt,
  supervisor: NodeWorkerProcessIdentity,
  worker: NodeWorkerProcessIdentity | null,
  container?: NodeWorkerContainerIdentity,
): boolean {
  const sameProcess = (
    left: NodeWorkerProcessIdentity | null,
    right: NodeWorkerProcessIdentity | null,
  ) =>
    left?.pid === right?.pid &&
    left?.startTime === right?.startTime &&
    (left !== null) === (right !== null);
  return (
    sameProcess(receipt.supervisor, supervisor) &&
    sameProcess(receipt.worker, worker) &&
    receipt.container?.engine === container?.engine &&
    receipt.container?.containerId === container?.containerId &&
    receipt.container?.engineTarget === container?.engineTarget
  );
}

/** Retains a terminal observation until its exact supervisor owner durably reconciles it. */
export function createNodeWorkerTerminalObserver(
  activeOwners: Map<string, NodeWorkerActiveOwnership>,
  reconcile: (observed: NodeWorkerObservedTerminal) => Promise<unknown>,
) {
  return async (
    active: NodeWorkerRunningChild,
    outcome: NodeWorkerTerminalOutcome,
  ): Promise<void> => {
    const observed = createNodeWorkerObservedTerminal(active, outcome);
    if (activeOwners.get(active.launchId) !== active) {
      return;
    }
    activeOwners.set(active.launchId, observed);
    try {
      await reconcile(observed);
    } catch {
      // The observed outcome stays owned in memory for the next supervisor operation.
      return;
    }
    active.turn = undefined;
  };
}
