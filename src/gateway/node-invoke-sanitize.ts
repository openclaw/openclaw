import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";
import type { GatewayClient } from "./server-methods/types.js";

export function sanitizeNodeInvokeParamsForForwarding(opts: {
  /** Target node id used by command-specific approval checks. */
  nodeId: string;
  /** Node command being forwarded through the Gateway. */
  command: string;
  /** Raw caller params before command-specific filtering. */
  rawParams: unknown;
  /** Gateway client requesting the invoke; null for trusted internal callers. */
  client: GatewayClient | null;
  /** Approval state used by sensitive commands such as system.run. */
  execApprovalManager?: ExecApprovalManager;
}):
  | {
      /** Params are safe to forward to the selected node. */
      ok: true;
      /** Sanitized params that may differ from rawParams for sensitive commands. */
      params: unknown;
    }
  | {
      /** Params must not be forwarded. */
      ok: false;
      /** Caller-safe rejection message. */
      message: string;
      /** Optional JSON-safe rejection details for gateway responses. */
      details?: Record<string, unknown>;
    } {
  if (opts.command === "system.run") {
    return sanitizeSystemRunParamsForForwarding({
      nodeId: opts.nodeId,
      rawParams: opts.rawParams,
      client: opts.client,
      execApprovalManager: opts.execApprovalManager,
    });
  }
  return { ok: true, params: opts.rawParams };
}
