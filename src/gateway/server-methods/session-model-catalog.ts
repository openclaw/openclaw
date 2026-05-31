import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

const SESSION_METADATA_MODEL_CATALOG_TIMEOUT_MS = 750;

let loggedSlowSessionMetadataCatalog = false;

export async function loadOptionalSessionMetadataModelCatalog(
  context: GatewayRequestContext,
  surface: string,
): Promise<ModelCatalogEntry[] | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("session-metadata-model-catalog-timeout");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), SESSION_METADATA_MODEL_CATALOG_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([
      context.loadGatewayModelCatalog().catch(() => undefined),
      timeoutPromise,
    ]);
    if (result === timedOut) {
      if (!loggedSlowSessionMetadataCatalog) {
        loggedSlowSessionMetadataCatalog = true;
        context.logGateway.debug(
          `${surface} continuing without model catalog after ${SESSION_METADATA_MODEL_CATALOG_TIMEOUT_MS}ms`,
        );
      }
      return undefined;
    }
    return Array.isArray(result) ? result : undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
