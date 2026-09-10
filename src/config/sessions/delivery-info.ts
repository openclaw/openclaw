// Delivery lookup recovers routable channel context from persisted session stores.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveSessionStoreIdentity,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { requiresFoldedSessionKeyAliasProof } from "../../sessions/session-key-utils.js";
import {
  deliveryContextFromSession,
  hasDeliveryTargetFields,
} from "../../utils/delivery-context.shared.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveSessionStorePathCore } from "./paths.js";
import {
  loadExactSessionEntryCandidatesReadOnlyBatch,
  loadExactSessionEntryReadOnly,
  openSessionEntryReadView,
  type SessionEntryReadSource,
  type SessionEntryReadView,
} from "./session-accessor.js";
import {
  foldedSessionKeyAliasCandidates,
  hasMismatchedCaseSensitiveDeliveryProof,
  isConfirmedLowercasedLegacyAlias,
  normalizeStoreSessionKey,
} from "./store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import type { SessionEntry } from "./types.js";

/** Reads only the current session; missing delivery must not widen into alias discovery. */
export function readExactSessionDeliveryContext(params: {
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
    const entry = loadExactSessionEntryReadOnly({
      storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
      sessionKey: canonicalKey,
      projection: "list",
    })?.entry;
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
export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): DeliveryInfo {
  return extractDeliveryInfoBatch([sessionKey], options)[0]!;
}

type DeliveryInfo = {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  threadId: string | undefined;
};

type DeliveryLookup = {
  sessionKeys: string[];
  baseKeys: string[];
  storePaths: string[];
};

type DeliveryStoreRead = {
  get: SessionEntryReadView["get"];
  normalizedIndex: () => Map<string, SessionEntry>;
};

/** Resolves one synchronous batch; only detached delivery facts leave the read scope. */
export function extractDeliveryInfoBatch(
  sessionKeys: readonly (string | undefined)[],
  options?: { cfg?: OpenClawConfig },
): DeliveryInfo[] {
  const parsed = sessionKeys.map((sessionKey) => ({
    sessionKey,
    ...parseSessionThreadInfo(sessionKey),
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
  const reads: Array<{
    storePath: string;
    sessionKeys: string[];
    source?: SessionEntryReadSource;
  }> = [];
  const lookups = parsed.flatMap(({ sessionKey, baseSessionKey }, index) => {
    if (!sessionKey || !baseSessionKey) {
      return [];
    }
    try {
      const lookup = prepareDeliveryLookup({ cfg, sessionKey, baseSessionKey });
      // Incognito keyed reads retain their existing process-owned handle lifetime.
      const readIndexes = isIncognitoSessionKey(sessionKey)
        ? undefined
        : lookup.storePaths.map((storePath) => {
            reads.push({
              storePath,
              sessionKeys: deliveryLookupExactKeys([...lookup.sessionKeys, ...lookup.baseKeys]),
            });
            return reads.length - 1;
          });
      return [{ index, sessionKey, baseSessionKey, lookup, readIndexes }];
    } catch {
      return [];
    }
  });
  const readGroups = new Map<string, number[]>();
  for (const [index, read] of reads.entries()) {
    const group = readGroups.get(read.storePath) ?? [];
    group.push(index);
    readGroups.set(read.storePath, group);
  }
  const exactResults = new Map<
    number,
    ReturnType<typeof loadExactSessionEntryCandidatesReadOnlyBatch>[number]
  >();
  const readExact = (index: number) => {
    const cached = exactResults.get(index);
    if (cached) {
      return cached;
    }
    // Admit a fallback store only when a lookup reaches it. Requests that share
    // that store still share one synchronous batch and retain individual errors.
    const group = readGroups.get(reads[index]!.storePath)!;
    const loaded = loadExactSessionEntryCandidatesReadOnlyBatch(
      group.map((readIndex) => {
        const read = reads[readIndex]!;
        return {
          storePath: read.storePath,
          sessionKeys: read.sessionKeys,
          projection: "list",
          onReadSource: (source) => {
            read.source = source;
          },
        };
      }),
    );
    for (const [offset, readIndex] of group.entries()) {
      exactResults.set(readIndex, loaded[offset]!);
    }
    return exactResults.get(index)!;
  };
  const indexes = new Map<string, DeliveryStoreRead["normalizedIndex"]>();
  for (const { index, sessionKey, baseSessionKey, lookup, readIndexes } of lookups) {
    try {
      const selected = loadDeliverySessionEntry(lookup, (storePath, storeIndex) => {
        const readIndex = readIndexes?.[storeIndex];
        const read = readIndex === undefined ? undefined : reads[readIndex];
        const exact = readIndex === undefined ? undefined : readExact(readIndex);
        if (exact && !exact.ok) {
          throw exact.error;
        }
        const source = read?.source;
        const indexKey = source ? `${source.agentId}\u0000${source.path}` : storePath;
        let normalizedIndex = indexes.get(indexKey);
        if (!normalizedIndex) {
          normalizedIndex = lazyDeliveryIndex(
            source ? { storePath: source.path, agentId: source.agentId } : { storePath },
          );
          indexes.set(indexKey, normalizedIndex);
        }
        const entries = exact?.ok
          ? new Map(exact.value.map(({ sessionKey: key, entry }) => [key, entry]))
          : undefined;
        const store = entries
          ? { get: (key: string) => entries.get(key) }
          : openSessionEntryReadView({ storePath, projection: "list" });
        return { get: store.get, normalizedIndex };
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
  let result: { index: Map<string, SessionEntry> } | { error: unknown } | undefined;
  return () => {
    if (!result) {
      try {
        result = {
          index: buildFreshestSessionEntryIndex(
            openSessionEntryReadView({ ...scope, projection: "list" }),
          ),
        };
      } catch (error) {
        result = { error };
      }
    }
    if ("error" in result) {
      throw result.error;
    }
    return result.index;
  };
}

function resolveDeliveryStorePaths(cfg: OpenClawConfig, agentId: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveSessionStorePathCore(cfg.session?.store, { agentId }));
  // Delivery can be restored from any resolved agent target; store order keeps the configured
  // primary path first while still covering per-agent stores.
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      paths.add(target.storePath);
    }
  }
  return [...paths];
}

function findSessionEntryInStore(store: DeliveryStoreRead, keys: readonly string[]) {
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
      const normalizedIndex = store.normalizedIndex();
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

function buildFreshestSessionEntryIndex(store: SessionEntryReadView): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const { sessionKey: key, entry } of store.entries()) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeStoreSessionKey(key);
    const existing = index.get(normalized);
    const entryRoutable = hasDeliveryTargetFields(deliveryContextFromSession(entry));
    const existingRoutable = hasDeliveryTargetFields(deliveryContextFromSession(existing));
    if (
      !existing ||
      (entryRoutable && !existingRoutable) ||
      (entryRoutable === existingRoutable && (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0))
    ) {
      index.set(normalized, entry);
    }
    // Lowercase aliases are only indexed when case folding is not proof-sensitive; Matrix-style
    // opaque ids must keep exact-case delivery evidence.
    const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
    if (foldedLegacyKey === normalized || requiresFoldedSessionKeyAliasProof(normalized)) {
      continue;
    }
    const foldedExisting = index.get(foldedLegacyKey);
    const foldedExistingRoutable = hasDeliveryTargetFields(
      deliveryContextFromSession(foldedExisting),
    );
    if (
      !foldedExisting ||
      (entryRoutable && !foldedExistingRoutable) ||
      (entryRoutable === foldedExistingRoutable &&
        (entry.updatedAt ?? 0) > (foldedExisting.updatedAt ?? 0))
    ) {
      index.set(foldedLegacyKey, entry);
    }
  }
  return index;
}

function prepareDeliveryLookup(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  baseSessionKey: string;
}): DeliveryLookup {
  const { agentId, canonicalKey: canonicalBaseKey } = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: params.baseSessionKey,
  });
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    storeAgentId: agentId,
  });
  return {
    sessionKeys: [params.sessionKey, canonicalKey],
    baseKeys: [params.baseSessionKey, canonicalBaseKey],
    storePaths: resolveDeliveryStorePaths(params.cfg, agentId),
  };
}

function loadDeliverySessionEntry(
  lookup: DeliveryLookup,
  readStore: (storePath: string, storeIndex: number) => DeliveryStoreRead,
) {
  let fallback:
    | {
        entry: ReturnType<typeof findSessionEntryInStore>;
        baseEntry: ReturnType<typeof findSessionEntryInStore>;
      }
    | undefined;
  for (const [storeIndex, storePath] of lookup.storePaths.entries()) {
    const store = readStore(storePath, storeIndex);
    const entry = findSessionEntryInStore(store, lookup.sessionKeys);
    const baseEntry = findSessionEntryInStore(store, lookup.baseKeys);
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
