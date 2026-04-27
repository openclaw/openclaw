import type { UpdateAvailable } from "../infra/update-startup.js";
import type { ConfigDiffEntry } from "./config-diff.js";

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;
export const GATEWAY_EVENT_CONFIG_CHANGED = "config.changed" as const;

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
};

export type GatewayConfigChangedEventPayload = {
  changes: ConfigDiffEntry[];
  changedAt: number;
};
