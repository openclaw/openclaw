import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { GatewayShutdownTrigger } from "../../process/gateway-work-admission.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";

export type GatewayRunSignalAction = "stop" | "restart" | "external-restart";

export type GatewayRunSignalRequest = {
  action: GatewayRunSignalAction;
  signal: GatewayShutdownTrigger;
  restartReason?: string;
  restartIntent?: GatewayRestartIntent;
  /** Cancellation removes the helper registry before this shutdown settles. */
  foregroundUpdate?: boolean;
  hostedStop?: ReturnType<typeof createGatewayHostLifecycle>;
};

export function isUpdateProcessRestartReason(reason: string | undefined): boolean {
  return reason === "update.run" || reason === "update.auto";
}

export const sameManagedUpdateOwner = (
  left: GatewayRestartIntent["successorOwner"],
  right: GatewayRestartIntent["successorOwner"],
) =>
  Boolean(
    left && right && left.handoffId === right.handoffId && left.installRoot === right.installRoot,
  );
