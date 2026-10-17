import type { DedupeCache } from "../../../infra/dedupe.js";
import { readGlobalSingleton } from "../../../shared/global-singleton.js";

/** Clear the process-global redelivery cache between tests, including fresh module instances. */
export function resetRecentQueuedMessageIdDedupe(): void {
  const cache = readGlobalSingleton(Symbol.for("openclaw.recentQueueMessageIdOwners")) as
    | DedupeCache
    | undefined;
  cache?.clear();
}
