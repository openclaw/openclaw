import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasOperatorBoundary } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "./session-sharing-policy.js";
import { createSessionListEntryFilter } from "./session-sharing-read.js";

/** Whether this caller may read or write the source conversation that owns a supervised task. */
export function canAccessSupervisedSourceSession(params: {
  access: "read" | "write";
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  agentId: string;
  sessionKey: string;
}): boolean {
  if (isGatewayAdmin(params.client)) {
    return true;
  }
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (
    authorizeIncognitoSessionTarget({
      client: params.client,
      sessionKey: params.sessionKey,
      target,
    })
  ) {
    return false;
  }
  if (!hasOperatorBoundary(params.client, params.cfg)) {
    return true;
  }
  if (!target) {
    return false;
  }
  if (params.access === "write") {
    return !authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target });
  }
  const visibilityFilter = createSessionListEntryFilter({
    cfg: params.cfg,
    client: params.client,
  });
  return visibilityFilter?.(target.storeKey, target.entry) ?? true;
}
