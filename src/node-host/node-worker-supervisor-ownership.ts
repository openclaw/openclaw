import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  NodeWorkerEnvironmentStopInput,
  NodeWorkerLaunchInput,
  NodeWorkerSupervisorIdentity,
} from "../worker/node-supervisor-protocol.js";
import type { NodeWorkerContainerEngine } from "./node-worker-container-engine.js";
import {
  snapshotNodeWorkerExecutionEnv,
  type NodeWorkerManagedIdentityTransport,
  type NodeWorkerPlatformTrust,
} from "./node-worker-environment.js";
import type { NodeWorkerTerminalOutcome } from "./node-worker-launch-observation.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchClaim,
  NodeWorkerLaunchReceipt,
  NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import type { NodeWorkerNativeInferenceSnapshot } from "./node-worker-native-inference.js";
import type { NodeWorkerCredentialScrubber } from "./node-worker-output.js";
import type { NodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

export const NODE_WORKER_STOP_GRACE_MS = 1_000;
export const NODE_WORKER_FORCE_STOP_WAIT_MS = 4_000;

export type NodeWorkerStopState = Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;

export type NodeWorkerEnvironmentBinding = ReturnType<typeof nodeWorkerEnvironmentBinding>;

export type NodeWorkerPendingAdmission = {
  binding: NodeWorkerEnvironmentBinding;
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
  binding: NodeWorkerEnvironmentStopInput,
  expected: NodeWorkerEnvironmentStopInput,
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
  idleGeneration?: number;
  retention?:
    | { reason: "background"; turnId: string }
    | { reason: "idle"; turnId: string; since: number; timer: NodeJS.Timeout };
  stopState?: NodeWorkerStopState;
  containerCleanup?: Promise<void>;
  deferredOutcome?: NodeWorkerTerminalOutcome;
};

export function clearNodeWorkerRetention(active: NodeWorkerRunningChild): void {
  if (active.retention?.reason === "idle") {
    clearTimeout(active.retention.timer);
  }
  active.retention = undefined;
}

export type NodeWorkerObservedTerminal = NodeWorkerActiveBase & {
  state: "observed";
  outcome: NodeWorkerTerminalOutcome;
  turn?: NodeWorkerActiveTurn;
  cancelledTurn?: NodeWorkerLaunchClaim;
  reconciliation?: Promise<NodeWorkerLaunchReceipt>;
};

export function createNodeWorkerObservedTerminal(
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
  /** Node-local canonical models captured before the runtime yields. */
  nativeInferenceSnapshot?: NodeWorkerNativeInferenceSnapshot;
  /** Captured only by the dedicated node runtime; absent on ordinary paired hosts. */
  managedIdentityTransport?: NodeWorkerManagedIdentityTransport;
  platformTrust?: NodeWorkerPlatformTrust;
};

/** Container execution never borrows the dedicated node's platform/provider custody. */
export function prepareNodeWorkerSupervisorEnvironment(options: NodeWorkerSupervisorOptions) {
  const env = options.env ?? process.env;
  const managedIdentityTransport = options.containerEngine
    ? undefined
    : options.managedIdentityTransport;
  const platformTrust = options.containerEngine ? undefined : options.platformTrust;
  return {
    nativeInferenceSnapshot: options.nativeInferenceSnapshot,
    managedIdentityTransport,
    platformTrust,
    workerEnv: snapshotNodeWorkerExecutionEnv(env, managedIdentityTransport, platformTrust),
    engineEnv: { ...process.env, ...env },
  };
}

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
