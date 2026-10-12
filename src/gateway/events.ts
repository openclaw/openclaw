import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { READ_SCOPE } from "./operator-scopes.js";

export const GATEWAY_EVENT_DEVICE_PAIR_CHANGED = "device.pair.changed" as const;

export const GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED = "node.runnerInventory.changed" as const;

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Active update ledger progress; detailed records remain admin-scoped. */
export const GATEWAY_EVENT_UPDATE_RUN_CHANGED = "update.run.changed" as const;

export function canReadDetailedUpdateMetadata(role: string, scopes: readonly string[]): boolean {
  return roleScopesAllow({
    role,
    requestedScopes: [READ_SCOPE],
    allowedScopes: scopes,
  });
}

/** Projects update availability to the pre-detail wire shape for clients without read access. */
export function projectUpdateAvailable(
  updateAvailable: UpdateAvailable | null | undefined,
  includeDetails: boolean,
): UpdateAvailable | null | undefined {
  if (!updateAvailable || includeDetails) {
    return updateAvailable;
  }
  return {
    currentVersion: updateAvailable.currentVersion,
    latestVersion: updateAvailable.latestVersion,
    channel: updateAvailable.channel,
  };
}

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};
