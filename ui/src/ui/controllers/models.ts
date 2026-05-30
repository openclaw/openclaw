import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry, ModelsProbeResult } from "../types.ts";

/**
 * Fetch the model catalog from the gateway.
 *
 * Accepts a {@link GatewayBrowserClient} (matching the existing ui/ controller
 * convention).  Returns an array of {@link ModelCatalogEntry}; on failure the
 * caller receives an empty array rather than throwing.
 */
export async function loadModels(client: GatewayBrowserClient): Promise<ModelCatalogEntry[]> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {
      view: "configured",
    });
    return result?.models ?? [];
  } catch {
    return [];
  }
}

export async function probeModelProvider(
  client: GatewayBrowserClient,
  params: {
    provider: string;
    model: string;
    providerConfig?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<ModelsProbeResult> {
  return await client.request<ModelsProbeResult>("models.probe", {
    provider: params.provider,
    model: params.model,
    ...(params.providerConfig ? { providerConfig: params.providerConfig } : {}),
    timeoutMs: params.timeoutMs ?? 20_000,
  });
}
