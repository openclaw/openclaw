import { recordWorkerPlacementStage } from "./placement-diagnostics.js";

export function createNodeWorkspaceRpcFailureReporter(
  owner: {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    abortController: AbortController;
  },
  commandSignal: AbortSignal | undefined,
  deadlineSignal: AbortSignal,
) {
  const startedAt = performance.now();
  const state = {
    phase: "node_lookup" as "node_lookup" | "invoke" | "response",
    dispatchStarted: false,
  };
  return {
    state,
    report: (error: unknown) =>
      recordWorkerPlacementStage(owner.sessionId, "node_workspace_rpc_failed", {
        environmentId: owner.environmentId,
        ownerEpoch: owner.ownerEpoch,
        diagnosticCode: "operation_failed",
        error,
        elapsedMs: performance.now() - startedAt,
        rpcPhase: state.phase,
        failureKind: state.phase === "response" ? "response" : "exception",
        cancellationSource: owner.abortController.signal.aborted
          ? "tunnel_owner"
          : commandSignal?.aborted
            ? "command"
            : deadlineSignal.aborted
              ? "deadline"
              : "none",
        dispatchStarted: state.dispatchStarted,
      }),
  };
}

export type NodeTunnelRetirementReason =
  | "owner_stop"
  | "provider-destroying"
  | "provider-destroyed"
  | "workspace_drain_failed";

export function reportNodeTunnelRetired(
  owner: {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    abortController: AbortController;
  },
  reason: NodeTunnelRetirementReason,
) {
  if (!owner.abortController.signal.aborted) {
    recordWorkerPlacementStage(owner.sessionId, "node_tunnel_retired", {
      environmentId: owner.environmentId,
      ownerEpoch: owner.ownerEpoch,
      tunnelRetirementReason: reason,
    });
  }
}

export function createNodeWorkspaceCommandSignals(
  owner: AbortSignal,
  command: AbortSignal | undefined,
  timeoutMs: number,
) {
  const deadlineSignal = AbortSignal.timeout(timeoutMs);
  return {
    deadlineSignal,
    signal: AbortSignal.any([owner, deadlineSignal, ...(command ? [command] : [])]),
  };
}
