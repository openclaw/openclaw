import type { GatewaySessionRow, ModelCatalogEntry } from "../api/types.ts";

export function isSessionRuntimePinned(runtime: GatewaySessionRow["agentRuntime"]): boolean {
  return runtime?.source === "session-key" || runtime?.source === "session";
}

export type ModelRuntimeEntry = Omit<ModelCatalogEntry, "unavailableReason"> & {
  unavailableReason?:
    | ModelCatalogEntry["unavailableReason"]
    | NonNullable<ModelCatalogEntry["runtimeChoices"]>[number]["unavailableReason"];
};

/** Runtime capabilities are a complete projection; missing fields must not inherit another harness. */
export function resolveModelRuntimeEntry(
  entry: ModelCatalogEntry | undefined,
  agentRuntime: string | null | undefined,
): ModelRuntimeEntry | undefined {
  if (!entry || !agentRuntime || entry.agentRuntime?.id === agentRuntime) {
    return entry;
  }
  const choice = entry.runtimeChoices?.find(
    (candidate) => candidate.agentRuntime.id === agentRuntime,
  );
  return choice
    ? {
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        alias: entry.alias,
        tags: entry.tags,
        apiKeySupported: entry.apiKeySupported,
        ...choice,
      }
    : undefined;
}
