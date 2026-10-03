/** @deprecated Stable SDK reporting contract. Job delivery now owns notification visibility. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ResolvedHeartbeatVisibility = {
  showOk: boolean;
  showAlerts: boolean;
  useIndicator: boolean;
};
export function resolveHeartbeatVisibility(_params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): ResolvedHeartbeatVisibility {
  // Historical ACKs remain hidden; ordinary replies use the normal channel policy.
  return { showOk: false, showAlerts: true, useIndicator: true };
}
