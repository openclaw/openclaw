import {
  getGatewayInstallationReplacement,
  registerGatewayInstallationReplacementHandler,
  type GatewayInstallationReplacement,
} from "../../gateway/stale-install.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayShutdownTrigger } from "../../process/gateway-work-admission.js";
import { formatCliCommand } from "../command-format.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";

export type GatewayRunSignalAction = "stop" | "restart" | "external-restart";

export type GatewayRunSignalRequest = {
  acceptedAtMs: number;
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

export function registerGatewayRunInstallationReplacement(params: {
  waitForUpdates: () => Promise<void> | undefined;
  accept: (fact: GatewayInstallationReplacement) => void;
  logger: Pick<SubsystemLogger, "warn" | "error">;
  supervised: boolean;
}): () => void {
  let current = true;
  const release = registerGatewayInstallationReplacementHandler((fact) => {
    const accept = () => {
      if (!current || getGatewayInstallationReplacement() !== fact) {
        return;
      }
      const pending = params.waitForUpdates();
      if (pending) {
        void pending.then(accept).catch((error: unknown) => {
          if (current) {
            params.logger.error(
              `Installation replacement restart deferred: system-service update settlement failed: ${formatErrorMessage(error)}`,
            );
          }
        });
        return;
      }
      params.logger.warn(fact.message);
      if (!params.supervised) {
        params.logger.error(
          `The foreground Gateway must stop after its installation was replaced. Restart it with: ${formatCliCommand("openclaw gateway run")}`,
        );
      }
      params.accept(fact);
    };
    accept();
  });
  return () => {
    current = false;
    release();
  };
}

export const sameManagedUpdateOwner = (
  left: GatewayRestartIntent["successorOwner"],
  right: GatewayRestartIntent["successorOwner"],
) =>
  Boolean(
    left && right && left.handoffId === right.handoffId && left.installRoot === right.installRoot,
  );

export function resolveGatewayRunSignalRequestUpgrade(
  current: GatewayRunSignalRequest | null,
  incoming: GatewayRunSignalRequest,
): GatewayRunSignalRequest | undefined {
  const { action, signal, restartReason, restartIntent } = incoming;
  if (
    action === "restart" &&
    isUpdateProcessRestartReason(restartReason) &&
    current?.action === "restart" &&
    (!isUpdateProcessRestartReason(current.restartReason) ||
      (restartIntent?.successorOwner &&
        !sameManagedUpdateOwner(
          restartIntent.successorOwner,
          current.restartIntent?.successorOwner,
        )))
  ) {
    return {
      ...current,
      signal,
      restartReason,
      foregroundUpdate: incoming.foregroundUpdate,
      restartIntent: {
        ...current.restartIntent,
        ...restartIntent,
        force: true,
        reason: restartReason,
      },
    };
  }
  return undefined;
}
