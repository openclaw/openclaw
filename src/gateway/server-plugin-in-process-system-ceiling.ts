import type { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import type { DispatchGatewayMethodInProcessOptions } from "./server-plugin-in-process-dispatch.types.js";

/**
 * Built-in requests retain the explicit ceiling of a positively scoped System caller.
 *
 * Subagents and settle wakes run their tools under a write-only System launch client. A run
 * may still register its own exec approval and await the verdict there, as its System-started
 * parent can; resolving an approval keeps the ceiling.
 */
export function resolveSystemScopeCeiling(
  method: string,
  options: DispatchGatewayMethodInProcessOptions | undefined,
  client: GatewayClient | null | undefined,
  caller: ReturnType<typeof getGatewayToolCallerIdentity>,
): string[] | undefined {
  if (
    options?.syntheticScopeMode === undefined ||
    resolveGatewayOperatorRoleActor(client)?.kind !== "system"
  ) {
    return undefined;
  }
  const ownRunExecApproval =
    options.syntheticScopeMode === "minimum" &&
    caller?.operationalRunInstance !== undefined &&
    (method === "exec.approval.request" || method === "exec.approval.waitDecision");
  return ownRunExecApproval ? undefined : (client?.connect.scopes ?? []);
}
