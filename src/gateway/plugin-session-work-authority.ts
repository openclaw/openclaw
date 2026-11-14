import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginServiceSessionWorkContextV1 } from "../plugins/service-session-work.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Host-only scope. Never assembled from RPC parameters or plugin-owned state. */
export type PluginSessionWorkAuthority = PluginServiceSessionWorkContextV1 & {
  pluginId: string;
  context: GatewayRequestContext;
  assertToolAllowed: (name: string) => void;
};
const current = new AsyncLocalStorage<PluginSessionWorkAuthority>();
export const readPluginSessionWorkAuthority = () => current.getStore();
export function runWithPluginSessionWorkAuthority<T>(
  authority: PluginSessionWorkAuthority,
  run: () => T,
): T {
  authority.assertCurrent();
  return current.run(authority, run);
}

/** Scheduled service work must acquire a fresh borrow instead of inheriting a settled one. */
export function runOutsidePluginSessionWorkAuthority<T>(run: () => T): T {
  return current.exit(run);
}

/** Apply the accepted operation's ceiling before any in-process method dispatch. */
export function resolvePluginSessionWorkDispatch({
  method,
  params,
  context,
  scopedPluginId,
  pluginRuntimeOwnerId,
}: {
  method: string;
  params: unknown;
  context: GatewayRequestContext;
  scopedPluginId?: string;
  pluginRuntimeOwnerId?: string;
}): PluginSessionWorkAuthority | undefined {
  const service = readPluginSessionWorkAuthority();
  if (service) {
    service.assertCurrent();
    if (
      context !== service.context ||
      scopedPluginId?.trim() !== service.pluginId ||
      (pluginRuntimeOwnerId !== undefined && pluginRuntimeOwnerId !== service.pluginId)
    ) {
      throw new Error("Accepted service work cannot target another plugin or Gateway");
    }
    const request = isRecord(params) ? params : {};
    const requiredTool =
      method === "tools.invoke"
        ? typeof request.name === "string"
          ? request.name
          : undefined
        : context.getGatewayMethodRegistry?.()?.getSessionAccess?.(method)?.requiredTool;
    if (!requiredTool) {
      throw new Error("Accepted service work requires a registered session-tool boundary");
    }
    if (
      request.sessionKey !== service.target.sessionKey ||
      request.agentId !== service.target.agentId
    ) {
      throw new Error("Accepted service work cannot target another conversation");
    }
    service.assertToolAllowed(requiredTool);
  }
  return service;
}
