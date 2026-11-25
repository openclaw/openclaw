import { resolveGlobalMap } from "../../shared/global-singleton.js";
import {
  registerOpenClawStateDatabaseAsyncResource,
  registerOpenClawStatePathCacheInvalidation,
} from "../../state/openclaw-state-db-cache.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type {
  ChannelIngressFailedHealth,
  ChannelIngressPressureSnapshot,
} from "./ingress-queue-read-contract.js";

type HealthCache = {
  path: string;
  failed?: ChannelIngressFailedHealth[];
  pressure?: ChannelIngressPressureSnapshot & { readAtMs: number };
};

const caches = resolveGlobalMap<string, HealthCache>(
  Symbol.for("openclaw.channelIngressHealth"),
  "close-and-restart",
);

registerOpenClawStateDatabaseAsyncResource({
  async close() {
    caches.clear();
  },
});

registerOpenClawStatePathCacheInvalidation(caches);

export function channelIngressHealthCache(context: OpenClawStateWorkerContext): HealthCache {
  const { coordinationKey, identity } = context.admission;
  let cache = caches.get(coordinationKey);
  if (!cache) {
    cache = { path: identity.canonicalPath };
    caches.set(coordinationKey, cache);
  }
  return cache;
}

/** A settling queue mutation retires even a snapshot whose read is still in flight. */
export function invalidateChannelIngressHealth(context: OpenClawStateWorkerContext): void {
  caches.delete(context.admission.coordinationKey);
}
