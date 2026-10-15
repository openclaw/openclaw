import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import {
  resolveSessionStoreIdentity,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { requiresFoldedSessionKeyAliasProof } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import { hasDeliveryTargetFields } from "../../utils/delivery-context.shared.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import {
  readSessionEntryReadOnlyInWorker,
  readSessionEntriesFromStoreInWorker,
  readSessionEntrySummariesInWorker,
} from "./session-entry-read-runtime.js";
import {
  foldedSessionKeyAliasCandidates,
  hasMismatchedCaseSensitiveDeliveryProof,
  isConfirmedLowercasedLegacyAlias,
  normalizeStoreSessionKey,
} from "./store-entry.js";
import { resolveAllAgentSessionStoreTargetsAsync } from "./targets-runtime.js";
import type { SessionEntry } from "./types.js";

/** Reads only the current session; missing delivery must not widen into alias discovery. */
export async function readExactSessionDeliveryContext(params: {
  cfg: OpenClawConfig;
  sessionKey: string | undefined;
  sessionId?: string;
}) {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  try {
    const { agentId, canonicalKey } = resolveSessionStoreIdentity({ cfg: params.cfg, sessionKey });
    const entry = await readSessionEntryReadOnlyInWorker({
      agentId,
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
      sessionKey: canonicalKey,
      projection: "list",
    });
    if (params.sessionId && entry?.sessionId !== params.sessionId) {
      return undefined;
    }
    return deliveryContextFromSession(entry);
  } catch {
    // A missing or unreadable store leaves the caller's existing inferred route intact.
    return undefined;
  }
}

/**
 * Extracts the routable delivery context and thread id for a persisted session key.
 *
 * Thread/topic keys first try their exact store entry, then fall back to the base session when
 * the thread entry has no delivery route of its own.
 */
export async function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): Promise<DeliveryInfo> {
  return (await extractDeliveryInfoBatch([sessionKey], options))[0]!;
}

type DeliveryInfo = {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  threadId: string | undefined;
};

type DeliveryLookup = {
  agentId: string;
  sessionKeys: string[];
  baseKeys: string[];
  storePaths: string[];
};

type DeliveryStoreRead = {
  get: (sessionKey: string) => SessionEntry | undefined;
  normalizedIndex: () => Promise<Map<string, SessionEntry>>;
};

/** Resolves one batch through the session owner; only detached delivery facts leave the read scope. */
export async function extractDeliveryInfoBatch(
  sessionKeys: readonly (string | undefined)[],
  options?: { cfg?: OpenClawConfig },
): Promise<DeliveryInfo[]> {
  const parsed = sessionKeys.map((sessionKey) => ({
    sessionKey,
    ...resolveSessionThreadInfo(sessionKey),
  }));
  const results: DeliveryInfo[] = parsed.map(({ threadId }) => ({
    deliveryContext: undefined,
    threadId,
  }));
  if (!parsed.some(({ sessionKey, baseSessionKey }) => sessionKey && baseSessionKey)) {
    return results;
  }
  let cfg: OpenClawConfig;
  try {
    cfg = options?.cfg ?? getRuntimeConfig();
  } catch {
    return results;
  }
  let storeTargets: Awaited<ReturnType<typeof resolveAllAgentSessionStoreTargetsAsync>>;
  try {
    storeTargets = await resolveAllAgentSessionStoreTargetsAsync(cfg);
  } catch {
    return results;
  }
  function prepareDeliveryLookup(sessionKey: string, baseSessionKey: string): DeliveryLookup {
    const { agentId, canonicalKey: canonicalBaseKey } = resolveSessionStoreIdentity({
      cfg,
      sessionKey: baseSessionKey,
    });
    const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: agentId });
    const incognito = isIncognitoSessionKey(sessionKey)
      ? captureMemoryExactSessionReader({ agentId, sessionKey })
      : undefined;
    const storePaths = new Set([
      incognito?.path ?? resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    ]);
    for (const target of incognito ? [] : storeTargets) {
      if (target.agentId === agentId) {
        storePaths.add(target.storePath);
      }
    }
    return {
      agentId,
      sessionKeys: [sessionKey, canonicalKey],
      baseKeys: [baseSessionKey, canonicalBaseKey],
      storePaths: [...storePaths],
    };
  }
  const lookups = parsed.flatMap(({ sessionKey, baseSessionKey }, index) => {
    if (!sessionKey || !baseSessionKey) {
      return [];
    }
    try {
      return [
        {
          index,
          sessionKey,
          baseSessionKey,
          lookup: prepareDeliveryLookup(sessionKey, baseSessionKey),
        },
      ];
    } catch {
      return [];
    }
  });
  const exactReads = new Map<
    string,
    Promise<{ entries: SessionEntrySummary[]; source?: { agentId: string; path: string } }>
  >();
  const readExact = (storePath: string, lookup: DeliveryLookup) => {
    const candidateKeys = deliveryLookupExactKeys([...lookup.sessionKeys, ...lookup.baseKeys]);
    const cacheKey = JSON.stringify([storePath, candidateKeys]);
    let read = exactReads.get(cacheKey);
    if (!read) {
      read = lookup.sessionKeys.some(isIncognitoSessionKey)
        ? Promise.all(
            candidateKeys.map(async (sessionKey) => {
              const entry = await readSessionEntryReadOnlyInWorker({
                agentId: lookup.agentId,
                storePath,
                sessionKey,
                projection: "list",
              });
              return entry ? [{ sessionKey, entry }] : [];
            }),
          ).then((rows) => ({ entries: rows.flat() }))
        : readSessionEntriesFromStoreInWorker({
            agentId: lookup.agentId,
            storePath,
            sessionKeys: candidateKeys,
            projection: "list",
            snapshotFields: [],
          });
      exactReads.set(cacheKey, read);
    }
    return read;
  };
  const indexes = new Map<string, DeliveryStoreRead["normalizedIndex"]>();
  for (const { index, sessionKey, baseSessionKey, lookup } of lookups) {
    try {
      const selected = await loadDeliverySessionEntry(lookup, async (storePath) => {
        const read = await readExact(storePath, lookup);
        const source = read.source;
        const indexKey = source ? `${source.agentId}\u0000${source.path}` : storePath;
        let normalizedIndex = indexes.get(indexKey);
        if (!normalizedIndex) {
          normalizedIndex = lazyDeliveryIndex(
            source ? { storePath: source.path, agentId: source.agentId } : { storePath },
          );
          indexes.set(indexKey, normalizedIndex);
        }
        const entries = new Map(read.entries.map(({ sessionKey: key, entry }) => [key, entry]));
        return { get: (key) => entries.get(key), normalizedIndex };
      });
      let context = deliveryContextFromSession(selected.entry);
      if (!hasDeliveryTargetFields(context) && baseSessionKey !== sessionKey) {
        context = deliveryContextFromSession(selected.baseEntry);
      }
      if (hasDeliveryTargetFields(context)) {
        results[index]!.deliveryContext = {
          channel: context.channel,
          to: context.to,
          accountId: context.accountId,
          threadId: context.threadId,
        };
      }
    } catch {
      // Delivery recovery remains best-effort for each logical lookup.
    }
  }
  return results;
}

function deliveryLookupExactKeys(keys: readonly string[]): string[] {
  return [
    ...new Set(
      keys.flatMap((key) => {
        const normalized = normalizeStoreSessionKey(key);
        return [normalized, ...foldedSessionKeyAliasCandidates(normalized), key.trim()];
      }),
    ),
  ];
}

function lazyDeliveryIndex(scope: {
  storePath: string;
  agentId?: string;
}): DeliveryStoreRead["normalizedIndex"] {
  let result: Promise<Map<string, SessionEntry>> | undefined;
  return () =>
    (result ??= readSessionEntrySummariesInWorker(scope).then(buildFreshestSessionEntryIndex));
}

async function findSessionEntryInStore(store: DeliveryStoreRead, keys: readonly string[]) {
  let bestEntry: SessionEntry | undefined;
  let bestUpdatedAt = 0;
  let bestRoutable = false;
  let bestExact = false;
  // Preference order: routable delivery context first; then Matrix/tail-preserved
  // exact keys over folded aliases; then freshness. Ordinary lowercase-canonical
  // channels keep the previous freshest-routable alias behavior.
  const acceptCandidate = (entry: SessionEntry | undefined, isExact = false) => {
    if (!entry) {
      return;
    }
    const candidateRoutable = hasDeliveryTargetFields(deliveryContextFromSession(entry));
    const candidateUpdatedAt = entry.updatedAt ?? 0;
    if (
      !bestEntry ||
      (candidateRoutable && !bestRoutable) ||
      (candidateRoutable === bestRoutable && isExact && !bestExact) ||
      (candidateRoutable === bestRoutable &&
        isExact === bestExact &&
        candidateUpdatedAt > bestUpdatedAt)
    ) {
      bestEntry = entry;
      bestUpdatedAt = candidateUpdatedAt;
      bestRoutable = candidateRoutable;
      bestExact = isExact;
    }
  };
  for (const key of keys) {
    const trimmed = key.trim();
    const normalized = normalizeStoreSessionKey(key);
    const foldedLegacyKeys = foldedSessionKeyAliasCandidates(normalized);
    const exactKeyWins = requiresFoldedSessionKeyAliasProof(normalized);
    let foundRoutableCandidate = false;
    // Exact and alias probes are raw keyed reads; the store is never enumerated here.
    const exactEntry = store.get(normalized);
    if (exactEntry && !hasMismatchedCaseSensitiveDeliveryProof(exactEntry, normalized)) {
      foundRoutableCandidate ||= hasDeliveryTargetFields(deliveryContextFromSession(exactEntry));
      acceptCandidate(exactEntry, exactKeyWins);
    }
    for (const foldedLegacyKey of foldedLegacyKeys) {
      const foldedLegacyEntry = store.get(foldedLegacyKey);
      if (!foldedLegacyEntry || !isConfirmedLowercasedLegacyAlias(foldedLegacyEntry, normalized)) {
        continue;
      }
      foundRoutableCandidate ||= hasDeliveryTargetFields(
        deliveryContextFromSession(foldedLegacyEntry),
      );
      acceptCandidate(foldedLegacyEntry);
    }
    const trimmedEntry = trimmed !== normalized ? store.get(trimmed) : undefined;
    if (trimmedEntry && !hasMismatchedCaseSensitiveDeliveryProof(trimmedEntry, normalized)) {
      foundRoutableCandidate ||= hasDeliveryTargetFields(deliveryContextFromSession(trimmedEntry));
      acceptCandidate(trimmedEntry);
    }
    if (trimmed !== normalized || !foundRoutableCandidate) {
      // Build the normalized index only after direct/exact probes fail; large session stores can
      // stay on the cheap path when the queried key already has routable delivery context.
      const normalizedIndex = await store.normalizedIndex();
      const freshest = normalizedIndex.get(normalized);
      if (!hasMismatchedCaseSensitiveDeliveryProof(freshest, normalized)) {
        acceptCandidate(freshest);
      }
      for (const foldedLegacyKey of foldedLegacyKeys) {
        const foldedFreshest = normalizedIndex.get(foldedLegacyKey);
        if (isConfirmedLowercasedLegacyAlias(foldedFreshest, normalized)) {
          acceptCandidate(foldedFreshest);
        }
      }
    }
  }
  return bestEntry;
}

function buildFreshestSessionEntryIndex(
  entries: readonly SessionEntrySummary[],
): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  const indexEntry = (key: string, entry: SessionEntry) => {
    const existing = index.get(key);
    const entryRoutable = hasDeliveryTargetFields(deliveryContextFromSession(entry));
    const existingRoutable = hasDeliveryTargetFields(deliveryContextFromSession(existing));
    if (
      !existing ||
      (entryRoutable && !existingRoutable) ||
      (entryRoutable === existingRoutable && (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0))
    ) {
      index.set(key, entry);
    }
  };
  for (const { sessionKey: key, entry } of entries) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeStoreSessionKey(key);
    indexEntry(normalized, entry);
    // Lowercase aliases are only indexed when case folding is not proof-sensitive; Matrix-style
    // opaque ids must keep exact-case delivery evidence.
    const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
    if (foldedLegacyKey === normalized || requiresFoldedSessionKeyAliasProof(normalized)) {
      continue;
    }
    indexEntry(foldedLegacyKey, entry);
  }
  return index;
}

async function loadDeliverySessionEntry(
  lookup: DeliveryLookup,
  readStore: (storePath: string, storeIndex: number) => Promise<DeliveryStoreRead>,
) {
  let fallback:
    | {
        entry: Awaited<ReturnType<typeof findSessionEntryInStore>>;
        baseEntry: Awaited<ReturnType<typeof findSessionEntryInStore>>;
      }
    | undefined;
  for (const [storeIndex, storePath] of lookup.storePaths.entries()) {
    const store = await readStore(storePath, storeIndex);
    const entry = await findSessionEntryInStore(store, lookup.sessionKeys);
    const baseEntry = await findSessionEntryInStore(store, lookup.baseKeys);
    if (!entry && !baseEntry) {
      continue;
    }
    fallback ??= { entry, baseEntry };
    // Prefer the first store that can actually route delivery; keep a non-routable fallback only
    // so callers can still inspect thread ids when no target-bearing session exists.
    if (
      hasDeliveryTargetFields(deliveryContextFromSession(entry)) ||
      hasDeliveryTargetFields(deliveryContextFromSession(baseEntry))
    ) {
      return { entry, baseEntry };
    }
  }
  return fallback ?? { entry: undefined, baseEntry: undefined };
}
