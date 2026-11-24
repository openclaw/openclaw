import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { GatewaySessionRow } from "../api/types.ts";

// A non-local placement also includes paired devices. Only active ownership
// without a device runner identifies a cloud device; otherwise use neutral copy.
function sessionStopCopyKey(placement: GatewaySessionRow["placement"]) {
  return placement?.state === "active" && placement.runner?.kind !== "device"
    ? "sessionsView.stopCloudWorker"
    : "sessionsView.stopWorker";
}

export type CloudWorkerStopAction = {
  method: "sessions.reclaim";
  requiredScope: "operator.write";
  blocksActiveRun: boolean;
  copyKey: ReturnType<typeof sessionStopCopyKey>;
};

export function resolveCloudWorkerStopAction(
  placement: GatewaySessionRow["placement"],
): CloudWorkerStopAction | null {
  if (
    !placement ||
    !isCloudWorkerPlacementState(placement.state) ||
    (placement.state === "failed" && placement.recoveryAction === "restart")
  ) {
    return null;
  }
  return {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
    blocksActiveRun: placement.state === "active",
    copyKey: sessionStopCopyKey(placement),
  };
}
