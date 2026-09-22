import type { PreparedGatewayModelCatalog } from "../server-model-catalog.types.js";
import type { GatewayRequestContext } from "./types.js";

/** Reads already-published startup facts without starting provider discovery on an RPC hot path. */
export async function readPreparedServerMethodModelCatalog(
  context: GatewayRequestContext,
  options?: { agentId?: string },
): Promise<PreparedGatewayModelCatalog | undefined> {
  try {
    return context.readPreparedGatewayModelCatalog
      ? await context.readPreparedGatewayModelCatalog(options)
      : undefined;
  } catch {
    // Catalog metadata decorates these responses; owner selection or lifecycle
    // races must not make the primary roster/session RPC unavailable.
    return undefined;
  }
}

export async function readPreparedServerMethodModelCatalogs(
  context: GatewayRequestContext,
  agentIds: readonly string[],
): Promise<Map<string, PreparedGatewayModelCatalog | undefined>> {
  const catalogs = new Map<string, PreparedGatewayModelCatalog | undefined>();
  if (!context.readPreparedGatewayModelCatalogBatch) {
    // Public SDK contexts from older hosts may only provide the scalar reader.
    for (const agentId of agentIds) {
      catalogs.set(agentId, await readPreparedServerMethodModelCatalog(context, { agentId }));
    }
    return catalogs;
  }
  try {
    const results = await context.readPreparedGatewayModelCatalogBatch(agentIds);
    agentIds.forEach((agentId, index) => {
      const result = results[index];
      catalogs.set(agentId, result?.status === "fulfilled" ? result.value : undefined);
    });
  } catch {
    // Loading the optional catalog owner can fail before individual reads start.
    for (const agentId of agentIds) {
      catalogs.set(agentId, undefined);
    }
  }
  return catalogs;
}
