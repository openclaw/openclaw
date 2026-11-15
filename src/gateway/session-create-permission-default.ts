import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";

/** Creation and its picker share the default; explicit modes retain their own authorization. */
export function resolveAttendedSessionPermissionDefault(
  configuredMode: SessionPermissionMode | undefined,
  scopes: readonly string[],
): SessionPermissionMode | undefined {
  return configuredMode === "full" && !scopes.includes(ADMIN_SCOPE) && scopes.includes(WRITE_SCOPE)
    ? "workspace"
    : configuredMode;
}
