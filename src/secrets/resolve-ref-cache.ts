import type { SecretRef } from "../config/types.secrets.js";
import { secretRefKey, type ProviderRefGroup } from "./ref-contract.js";
import type { ProviderRefGroupResult } from "./resolve-batch.js";
import {
  isProviderScopedSecretResolutionError,
  isSecretResolutionError,
  refResolutionError,
} from "./resolve-errors.js";

/** Shares cached ref promises while keeping provider batch execution under one owner. */
export async function resolveProviderRefGroupWithCache(params: {
  group: ProviderRefGroup;
  errorMode: "continue" | "stop";
  cache: Map<string, Promise<unknown>>;
  resolveBatch: (refs: SecretRef[]) => Promise<ProviderRefGroupResult>;
}): Promise<ProviderRefGroupResult> {
  const { group, cache } = params;
  const uncachedRefs = group.refs.filter((ref) => !cache.has(secretRefKey(ref)));
  let batchPromise: Promise<ProviderRefGroupResult> | undefined;
  const resolveBatch = () => (batchPromise ??= params.resolveBatch(uncachedRefs));
  const ownedCacheEntries: Array<{ key: string; promise: Promise<unknown> }> = [];
  const refsWithPromises = group.refs.map((ref) => {
    const key = secretRefKey(ref);
    const cached = cache.get(key);
    if (cached) {
      return { ref, promise: cached };
    }
    const promise = Promise.resolve().then(async () => {
      const batch = await resolveBatch();
      const error = batch.refFailures.get(ref.id);
      if (error) {
        throw error;
      }
      if (!batch.values.has(ref.id)) {
        throw refResolutionError({
          code: "SECRET_REF_PROVIDER_CONTRACT",
          source: group.source,
          provider: group.providerName,
          refId: ref.id,
          message: `Secret provider "${group.providerName}" did not return id "${ref.id}".`,
        });
      }
      return batch.values.get(ref.id);
    });
    cache.set(key, promise);
    ownedCacheEntries.push({ key, promise });
    return { ref, promise };
  });
  const settled = await Promise.allSettled(refsWithPromises.map(({ promise }) => promise));
  // A provider-wide failure has no per-ref result, so do not cache it against every ref.
  if (batchPromise) {
    try {
      await batchPromise;
    } catch (error) {
      for (const { key, promise } of ownedCacheEntries) {
        if (cache.get(key) === promise) {
          cache.delete(key);
        }
      }
      throw error;
    }
  }

  const values = new Map<string, unknown>();
  const refFailures = new Map<string, ReturnType<typeof refResolutionError>>();
  for (const [index, result] of settled.entries()) {
    const ref = refsWithPromises[index]!.ref;
    if (result.status === "fulfilled") {
      values.set(ref.id, result.value);
    } else if (params.errorMode === "stop") {
      throw result.reason;
    } else if (
      isSecretResolutionError(result.reason) &&
      !isProviderScopedSecretResolutionError(result.reason)
    ) {
      refFailures.set(ref.id, result.reason);
    } else {
      throw result.reason;
    }
  }
  return { group, values, refFailures };
}
