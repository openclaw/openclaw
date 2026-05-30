import { normalizeOptionalString } from "../../shared/string-coerce.js";

const GENERATED_MEDIA_DELIVERY_TTL_MS = 10 * 60 * 1000;
const GENERATED_MEDIA_DELIVERY_MAX = 512;
const GENERATED_MEDIA_DELIVERY_STATE_KEY = "openclawRecentGeneratedMediaDeliveries";

const generatedMediaDeliveryState = globalThis as typeof globalThis & {
  openclawRecentGeneratedMediaDeliveries?: Map<string, number>;
};
const recentGeneratedMediaDeliveries =
  (generatedMediaDeliveryState[GENERATED_MEDIA_DELIVERY_STATE_KEY] ??= new Map<
    string,
    number
  >());

export type GeneratedMediaDeliveryRoute = {
  accountId?: string | null;
  channel?: string | null;
  to?: string | null;
  threadId?: string | number | null;
};

export function isGeneratedMediaUrl(mediaUrl: string): boolean {
  return /(?:^|[/\\])tool-(?:image|video|music)-generation(?:[/\\]|$)/.test(mediaUrl);
}

function pruneRecentGeneratedMediaDeliveries(now: number): void {
  for (const [key, deliveredAt] of recentGeneratedMediaDeliveries) {
    if (now - deliveredAt <= GENERATED_MEDIA_DELIVERY_TTL_MS) {
      continue;
    }
    recentGeneratedMediaDeliveries.delete(key);
  }
  while (recentGeneratedMediaDeliveries.size > GENERATED_MEDIA_DELIVERY_MAX) {
    const oldest = recentGeneratedMediaDeliveries.keys().next().value;
    if (!oldest) {
      break;
    }
    recentGeneratedMediaDeliveries.delete(oldest);
  }
}

export function resolveGeneratedMediaDeliveryKeys(params: {
  route: GeneratedMediaDeliveryRoute;
  mediaUrls: readonly string[];
}): string[] {
  const generatedMediaUrls = Array.from(
    new Set(
      params.mediaUrls
        .map((mediaUrl) => normalizeOptionalString(mediaUrl))
        .filter((mediaUrl): mediaUrl is string => Boolean(mediaUrl))
        .filter(isGeneratedMediaUrl),
    ),
  ).toSorted();
  // Generated artifact paths are single-use delivery artifacts. Dedupe by artifact, not by
  // route, because generated media can replay through different delivery owners for one turn.
  return generatedMediaUrls.map((mediaUrl) =>
    JSON.stringify({
      accountId: null,
      channel: null,
      to: null,
      threadId: null,
      mediaUrl,
    }),
  );
}

export function shouldSuppressGeneratedMediaDelivery(params: {
  route: GeneratedMediaDeliveryRoute;
  mediaUrls: readonly string[];
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  pruneRecentGeneratedMediaDeliveries(now);
  const keys = resolveGeneratedMediaDeliveryKeys(params);
  return keys.length > 0 && keys.every((key) => recentGeneratedMediaDeliveries.has(key));
}

export function markGeneratedMediaDelivered(params: {
  route: GeneratedMediaDeliveryRoute;
  mediaUrls: readonly string[];
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  pruneRecentGeneratedMediaDeliveries(now);
  for (const key of resolveGeneratedMediaDeliveryKeys(params)) {
    recentGeneratedMediaDeliveries.set(key, now);
  }
}

export function resetGeneratedMediaDeliveryDedupeForTest(): void {
  recentGeneratedMediaDeliveries.clear();
}
