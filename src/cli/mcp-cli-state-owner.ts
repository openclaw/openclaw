import {
  setConfiguredMcpServer as setConfiguredMcpServerLocally,
  unsetConfiguredMcpServer as unsetConfiguredMcpServerLocally,
  updateConfiguredMcpServer as updateConfiguredMcpServerLocally,
  updateConfiguredMcpServerTools as updateConfiguredMcpServerToolsLocally,
} from "../agents/mcp-config-mutation.js";
import { runWithLocalStateOwner } from "./local-state-owner.js";

// Probes can refresh credentials; config edits can clear them and write lifecycle state.
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
      runLocal: async (owner) => action(owner, ...args),
    });
}

export const setConfiguredMcpServer = offlineMcpAction(
  "set",
  (_owner, params: Parameters<typeof setConfiguredMcpServerLocally>[0]) =>
    setConfiguredMcpServerLocally(params),
);
export const unsetConfiguredMcpServer = offlineMcpAction(
  "unset",
  (_owner, params: Parameters<typeof unsetConfiguredMcpServerLocally>[0]) =>
    unsetConfiguredMcpServerLocally(params),
);
export const updateConfiguredMcpServer = offlineMcpAction(
  "configure",
  (_owner, params: Parameters<typeof updateConfiguredMcpServerLocally>[0]) =>
    updateConfiguredMcpServerLocally(params),
);
export const updateConfiguredMcpServerTools = offlineMcpAction(
  "tools",
  (_owner, params: Parameters<typeof updateConfiguredMcpServerToolsLocally>[0]) =>
    updateConfiguredMcpServerToolsLocally(params),
);
