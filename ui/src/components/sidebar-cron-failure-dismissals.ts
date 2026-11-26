import type { GatewayBrowserClient } from "../api/gateway.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  deferredCronFailurePrefix,
  loadDismissals,
  retireLegacyCronDismissal,
} from "./sidebar-attention-dismissals.ts";

function readDeferredFailures(key: string): Map<string, number> {
  const deferred = new Map<string, number>();
  const storage = getSafeLocalStorage();
  if (!storage) {
    return deferred;
  }
  const prefix = deferredCronFailurePrefix(key);
  try {
    for (let index = 0; index < storage.length; index++) {
      const pendingKey = storage.key(index);
      if (!pendingKey?.startsWith(prefix)) {
        continue;
      }
      const value = storage.getItem(pendingKey);
      const at = Number(value);
      if (value && Number.isSafeInteger(at) && at >= 0) {
        deferred.set(pendingKey.slice(prefix.length), at);
      }
    }
  } catch {
    // Browser storage can be denied while the Gateway remains available.
  }
  return deferred;
}

export async function importCronFailureDismissals(
  client: GatewayBrowserClient,
  key: string,
  isCurrent: () => boolean,
): Promise<void> {
  const legacy = loadDismissals(key).cronFailed ?? [];
  const deferred = readDeferredFailures(key);
  for (const id of new Set([...legacy, ...deferred.keys()])) {
    if (!isCurrent()) {
      return;
    }
    const at = deferred.get(id);
    try {
      const result = await client.request<{ acknowledgedAtMs: number | null }>(
        "cron.acknowledgeFailure",
        at === undefined ? { id, adopt: true } : { id, failedAtMs: at },
      );
      if (!isCurrent()) {
        return;
      }
      if (at === undefined) {
        if (typeof result.acknowledgedAtMs === "number") {
          retireLegacyCronDismissal(key, id);
        }
      } else {
        const storage = getSafeLocalStorage();
        const pendingKey = deferredCronFailurePrefix(key) + id;
        if (storage?.getItem(pendingKey) === String(at)) {
          storage.removeItem(pendingKey);
        }
      }
    } catch {
      // Leave unconfirmed browser records for a later connection to retry.
    }
  }
}
