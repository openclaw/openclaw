import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

const OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 750;

// Slow-catalog warnings are keyed by caller surface so one stuck provider does
// not turn high-frequency list/chat RPCs into repeated diagnostic noise.
const loggedSlowCatalogKeys = new Set<string>();

/**
 * Best-effort model catalog loader for metadata enrichment in latency-sensitive RPCs.
 *
 * Returns `undefined` instead of surfacing catalog load failures so callers can
 * preserve their primary response contract when provider discovery is optional.
 */
export async function loadOptionalServerMethodModelCatalog(
  context: GatewayRequestContext,
  surface: string,
  options?: { logOnceKey?: string },
): Promise<ModelCatalogEntry[] | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  // Use a private sentinel so a real catalog value cannot be confused with the
  // timeout branch even if a future loader broadens its return shape.
  const timedOut = Symbol("server-method-model-catalog-timeout");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), OPTIONAL_MODEL_CATALOG_TIMEOUT_MS);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([
      context.loadGatewayModelCatalog().catch(() => undefined),
      timeoutPromise,
    ]);
    if (result === timedOut) {
      const logOnceKey = options?.logOnceKey ?? "session-metadata";
      if (!loggedSlowCatalogKeys.has(logOnceKey)) {
        loggedSlowCatalogKeys.add(logOnceKey);
        // Catalog data is decorative for these responses; log once per surface
        // and keep the primary RPC responsive when provider discovery stalls.
        context.logGateway.debug(
          `${surface} continuing without model catalog after ${OPTIONAL_MODEL_CATALOG_TIMEOUT_MS}ms`,
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
