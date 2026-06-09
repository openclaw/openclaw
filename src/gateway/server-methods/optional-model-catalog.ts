// Optional model-catalog loading gives session/tool methods metadata when fast
// while never blocking their primary response path on catalog discovery.
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { GatewayRequestContext } from "./types.js";

/**
 * Optional model-catalog loader for methods where metadata improves the result
 * but should never block the primary session response path.
 */
const DEFAULT_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS = 750;

const loggedSlowCatalogKeys = new Set<string>();

export type OptionalServerMethodModelCatalogLoad = {
  promise: Promise<ModelCatalogEntry[] | undefined>;
};

type LoadOptionalServerMethodModelCatalogOptions = {
  logOnceKey?: string;
  startedLoad?: OptionalServerMethodModelCatalogLoad;
  timeoutMs?: number;
};

function normalizeOptionalModelCatalog(value: unknown): ModelCatalogEntry[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function startOptionalServerMethodModelCatalogLoad(
  context: GatewayRequestContext,
): OptionalServerMethodModelCatalogLoad {
  let catalogPromise: Promise<unknown>;
  try {
    catalogPromise = context.loadGatewayModelCatalog();
  } catch {
    catalogPromise = Promise.resolve(undefined);
  }
  const promise = catalogPromise.then(
    (value) => {
      const catalog = normalizeOptionalModelCatalog(value);
      return catalog;
    },
    () => {
      return undefined;
    },
  );
  return {
    promise,
  };
}

/** Loads the gateway model catalog with a short timeout and one-time slow logs. */
export async function loadOptionalServerMethodModelCatalog(
  context: GatewayRequestContext,
  surface: string,
  options?: LoadOptionalServerMethodModelCatalogOptions,
): Promise<ModelCatalogEntry[] | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Symbol("server-method-model-catalog-timeout");
  const timeoutMs = options?.timeoutMs ?? DEFAULT_OPTIONAL_MODEL_CATALOG_TIMEOUT_MS;
  const catalogLoad = options?.startedLoad ?? startOptionalServerMethodModelCatalogLoad(context);
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), timeoutMs);
    timeout.unref?.();
  });
  try {
    const result = await Promise.race([catalogLoad.promise, timeoutPromise]);
    if (result === timedOut) {
      const logOnceKey = options?.logOnceKey ?? "session-metadata";
      if (!loggedSlowCatalogKeys.has(logOnceKey)) {
        loggedSlowCatalogKeys.add(logOnceKey);
        context.logGateway.debug(`${surface} continuing without model catalog after ${timeoutMs}ms`);
      }
      return undefined;
    }
    return normalizeOptionalModelCatalog(result);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
