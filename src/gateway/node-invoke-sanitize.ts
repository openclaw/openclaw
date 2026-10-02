// Node invocation forwarding sanitizer.
// Strips or validates gateway-only control fields before node transport.
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";
import type { GatewayClient } from "./server-methods/types.js";

// Node invoke forwarding sanitizes command-specific payloads before they leave
// the gateway. system.run carries approval bindings and therefore needs special
// handling; other commands pass through unchanged.
/** Sanitizes node.invoke params before forwarding them to a connected node. */
export async function sanitizeNodeInvokeParamsForForwarding(opts: {
  nodeId: string;
  command: string;
  rawParams: unknown;
  client: GatewayClient | null;
  execApprovalManager?: ExecApprovalManager;
}): ReturnType<typeof sanitizeSystemRunParamsForForwarding> {
  if (opts.command === "system.run") {
    return sanitizeSystemRunParamsForForwarding(opts);
  }
  return { ok: true, params: opts.rawParams };
}
