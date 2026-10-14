import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY,
  validateSystemRunExecutionContext,
} from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";
import type { GatewayClient } from "./server-methods/types.js";

export async function sanitizeNodeInvokeParamsForForwarding(opts: {
  nodeId: string;
  command: string;
  caps?: readonly string[];
  rawParams: unknown;
  client: GatewayClient | null;
  execApprovalManager?: ExecApprovalManager;
}): ReturnType<typeof sanitizeSystemRunParamsForForwarding> {
  if (opts.command === "system.run" || opts.command === "system.run.prepare") {
    const context = asNullableRecord(opts.rawParams)?.executionContext;
    if (
      context !== undefined &&
      (!opts.caps?.includes(SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY) ||
        !validateSystemRunExecutionContext(context))
    ) {
      return {
        ok: false,
        message: "executionContext invalid or unsupported by node; update the node and Gateway",
      };
    }
  }
  if (opts.command === "system.run") {
    return sanitizeSystemRunParamsForForwarding(opts);
  }
  return { ok: true, params: opts.rawParams };
}
