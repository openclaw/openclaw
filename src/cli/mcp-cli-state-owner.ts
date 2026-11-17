import {
  setConfiguredMcpServer as setConfiguredMcpServerLocally,
  unsetConfiguredMcpServer as unsetConfiguredMcpServerLocally,
  updateConfiguredMcpServer as updateConfiguredMcpServerLocally,
  updateConfiguredMcpServerTools as updateConfiguredMcpServerToolsLocally,
} from "../agents/mcp-config-mutation.js";
import { mcpConfigInternal } from "../config/mcp-config.js";
import { bindConfigOwner } from "./config-cli-owner-patch.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

// Probes can refresh credentials and still require offline custody.
export function offlineMcpAction<Args extends unknown[], T>(
  command: string,
  action: (owner: { signal: AbortSignal; assertCurrent: () => void }, ...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  return (...args) =>
    runWithLocalStateOwner({
      method: `mcp.${command}`,
      params: {},
      target: "MCP credentials and configuration",
      onForeignOwner: "refuse",
      runLocal: (owner) => action(owner, ...args),
    });
}

function mcpConfigMutation<
  Params extends { commit?: Parameters<typeof mcpConfigInternal.set>[0]["commit"] },
  T,
>(
  command: string,
  runLocal: (params: Params) => Promise<T>,
  prepare: (params: Params) => Promise<T>,
): (params: Params) => Promise<T> {
  return (params) =>
    runWithLocalStateOwner({
      method: `mcp.${command}`,
      params: {},
      target: "MCP configuration",
      onForeignOwner: async ({ env, requestOwner }) => {
        return prepare({ ...params, commit: await bindConfigOwner(requestOwner, env) });
      },
      runLocal: () => runLocal(params),
    });
}

export const setMcpServer = mcpConfigMutation(
  "set",
  setConfiguredMcpServerLocally,
  mcpConfigInternal.set,
);
export const unsetMcpServer = mcpConfigMutation(
  "unset",
  unsetConfiguredMcpServerLocally,
  mcpConfigInternal.unset,
);
export const configureMcpServer = mcpConfigMutation(
  "configure",
  updateConfiguredMcpServerLocally,
  mcpConfigInternal.update,
);
export const updateMcpTools = mcpConfigMutation(
  "tools",
  updateConfiguredMcpServerToolsLocally,
  mcpConfigInternal.updateTools,
);
