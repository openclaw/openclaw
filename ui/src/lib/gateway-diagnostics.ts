import type { getCommandLaneDiagnostics } from "../../../src/process/command-lane-diagnostics.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

export type CommandLaneDiagnostics = ReturnType<typeof getCommandLaneDiagnostics>;

export async function loadCommandLaneDiagnostics(
  client: GatewayBrowserClient,
  signal?: AbortSignal,
): Promise<CommandLaneDiagnostics> {
  return client.request<CommandLaneDiagnostics>("diagnostics.lanes", {}, { signal });
}
