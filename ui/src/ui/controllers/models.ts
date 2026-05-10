import type { GatewayBrowserClient } from "../gateway.ts";
import type { ModelCatalogEntry } from "../types.ts";

/**
 * Fetch the model catalog from the gateway.
 *
 * Accepts a {@link GatewayBrowserClient} (matching the existing ui/ controller
 * convention).  Returns an array of {@link ModelCatalogEntry}; on failure the
 * caller receives an empty array rather than throwing.
 *
 * When `agentId` is provided, the gateway scopes the visibility allowlist to
 * the per-agent `agents.list[<agentId>].models` map (falling back to
 * `agents.defaults.models` when the agent does not define its own list).
 */
export async function loadModels(
  client: GatewayBrowserClient,
  options?: { agentId?: string | null },
): Promise<ModelCatalogEntry[]> {
  try {
    const agentId =
      typeof options?.agentId === "string" && options.agentId.trim().length > 0
        ? options.agentId.trim()
        : undefined;
    const params: { view: "configured"; agentId?: string } = { view: "configured" };
    if (agentId) {
      params.agentId = agentId;
    }
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", params);
    return result?.models ?? [];
  } catch {
    return [];
  }
}
