import type { CommandLaneSnapshot } from "../../../src/process/command-queue.types.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { HealthSnapshot, ModelCatalogResult, StatusSummary } from "../api/types.ts";

export type { CommandLaneSnapshot } from "../../../src/process/command-queue.types.js";

export type CommandLaneDynamicSummary = {
  laneCount: number;
  activeCount: number;
  queuedCount: number;
  queuedLaneCount: number;
};

export type CommandLaneDiagnostics = {
  lanes: CommandLaneSnapshot[];
  dynamic: CommandLaneDynamicSummary | null;
};

type GatewayDiagnosticsSnapshot = {
  status: StatusSummary;
  health: HealthSnapshot;
  models: unknown[];
  heartbeat: unknown;
  lanes: CommandLaneSnapshot[];
  dynamic: CommandLaneDynamicSummary | null;
};

export async function loadCommandLaneDiagnostics(
  client: GatewayBrowserClient,
  signal?: AbortSignal,
): Promise<CommandLaneDiagnostics> {
  return client.request<CommandLaneDiagnostics>("diagnostics.lanes", {}, { signal });
}

export async function loadGatewayDiagnostics(
  client: GatewayBrowserClient,
  agentId: string | null,
  signal?: AbortSignal,
): Promise<GatewayDiagnosticsSnapshot> {
  // Diagnostics sample the Gateway itself, independently of cached picker choices.
  const modelsRequest = agentId
    ? client.request<ModelCatalogResult>(
        "models.list",
        { agentId: agentId.trim(), view: "default" },
        { signal },
      )
    : Promise.resolve({ models: [] });
  const lanesRequest = loadCommandLaneDiagnostics(client, signal);
  const [status, health, models, heartbeat, laneDiagnostics] = await Promise.all([
    client.request("status", {}, { signal }),
    client.request("health", {}, { signal }),
    modelsRequest,
    client.request("last-heartbeat", {}, { signal }),
    lanesRequest,
  ]);
  return {
    status: status as StatusSummary,
    health: health as HealthSnapshot,
    models: models.models,
    heartbeat,
    ...laneDiagnostics,
  };
}
