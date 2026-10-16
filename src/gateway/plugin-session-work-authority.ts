import { AsyncLocalStorage } from "node:async_hooks";
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
