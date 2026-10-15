import type { getCommandLaneDiagnostics } from "../../../src/process/command-lane-diagnostics.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  CronStatus,
  HealthSnapshot,
  ModelCatalogResult,
  StatusSummary,
} from "../api/types.ts";

export type { CommandLaneSnapshot } from "../../../src/process/command-queue.types.js";

export type CommandLaneDiagnostics = ReturnType<typeof getCommandLaneDiagnostics>;
export type CommandLaneDynamicSummary = NonNullable<CommandLaneDiagnostics["dynamic"]>;

type GatewayDiagnosticsSnapshot = CommandLaneDiagnostics & {
  status: StatusSummary;
  health: HealthSnapshot;
  models: unknown[];
  automations: CronStatus;
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
  const [status, health, models, automations, laneDiagnostics] = await Promise.all([
    client.request<StatusSummary>("status", {}, { signal }),
    client.request<HealthSnapshot>("health", {}, { signal }),
    modelsRequest,
    client.request<CronStatus>("cron.status", {}, { signal }),
    lanesRequest,
  ]);
  return {
    status,
    health,
    models: models.models,
    automations,
    ...laneDiagnostics,
  };
}
