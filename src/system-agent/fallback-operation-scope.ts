import type { SystemAgentOperation } from "./operation-types.js";

export const BOUND_FALLBACK_OPERATION_SCOPE_MESSAGE =
  "This verified fallback can inspect state and apply guarded config/SecretRef changes, but cannot start a multi-stage privileged action. Use a freshly verified primary session or a direct operator action. No change was made.";

/** A fallback is an inference owner, not a blanket owner of asynchronous effects. */
export function isSystemAgentBoundFallbackOperationAllowed(
  operation: SystemAgentOperation,
): boolean {
  switch (operation.kind) {
    case "none":
    case "overview":
    case "agents":
    case "models":
    case "plugin-list":
    case "plugin-search":
    case "audit":
    case "config-validate":
    case "config-get":
    case "config-schema":
    case "channel-list":
    case "channel-info":
    case "doctor":
    case "status":
    case "health":
    case "gateway-status":
    case "config-set":
    case "config-unset":
    case "config-set-ref":
      return true;
    default:
      return false;
  }
}
