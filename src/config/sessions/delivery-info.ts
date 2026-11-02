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
  options?: { cfg?: OpenClawConfig; agentId?: string },
): Promise<DeliveryInfo> {
  return (await extractDeliveryInfoBatch([{ sessionKey, agentId: options?.agentId }], options))[0]!;
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
  exactKeys: string[];
  storePaths: string[];
};

type DeliveryStoreRead = {
  get: (sessionKey: string) => SessionEntry | undefined;
  foldedSignalIndex: () => Promise<Map<string, SessionEntry>>;
};

type DeliveryExactRead = {
  entries: SessionEntrySummary[];
  source?: { agentId: string; path: string };
};

/** Resolves one batch through the session owner; only detached delivery facts leave the read scope. */
export async function extractDeliveryInfoBatch(
  requests: readonly { sessionKey?: string; agentId?: string }[],
  options?: { cfg?: OpenClawConfig },
): Promise<DeliveryInfo[]> {
  const parsed = requests.map(({ sessionKey, agentId }) => ({
    sessionKey,
    agentId,
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
  function prepareDeliveryLookup(
    sessionKey: string,
    baseSessionKey: string,
    requestedAgentId?: string,
  ): DeliveryLookup {
    const { agentId, canonicalKey: canonicalBaseKey } = resolveSessionStoreIdentity({
      cfg,
      sessionKey: baseSessionKey,
      agentId: requestedAgentId,
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
      exactKeys: deliveryLookupExactKeys([
        sessionKey,
        canonicalKey,
        baseSessionKey,
        canonicalBaseKey,
      ]),
      storePaths: [...storePaths],
    };
  }
  const lookups = parsed.flatMap(({ sessionKey, baseSessionKey, agentId }, index) => {
    if (!sessionKey || !baseSessionKey) {
      return [];
    }
    try {
      return [
        {
          index,
          sessionKey,
          baseSessionKey,
          lookup: prepareDeliveryLookup(sessionKey, baseSessionKey, agentId),
        },
      ];
    } catch {
      return [];
    }
  });
  const firstStoreBatches = new Map<
    string,
    {
      keySets: Set<string>;
      keys: Set<string>;
      read?: Promise<
        | { entries: Map<string, SessionEntrySummary>; source: DeliveryExactRead["source"] }
        | undefined
      >;
    }
  >();
  for (const { lookup } of lookups) {
    if (lookup.sessionKeys.some(isIncognitoSessionKey)) {
      continue;
    }
    const key = JSON.stringify([lookup.agentId, lookup.storePaths[0]]);
    let batch = firstStoreBatches.get(key);
    if (!batch) {
      batch = { keySets: new Set(), keys: new Set() };
      firstStoreBatches.set(key, batch);
    }
    batch.keySets.add(JSON.stringify(lookup.exactKeys));
    for (const candidateKey of lookup.exactKeys) {
      batch.keys.add(candidateKey);
    }
  }
  const exactReads = new Map<string, Promise<DeliveryExactRead>>();
  const readIndependent = (storePath: string, lookup: DeliveryLookup) => {
    const candidateKeys = lookup.exactKeys;
    const cacheKey = JSON.stringify([lookup.agentId, storePath, candidateKeys]);
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
  const readExact = async (
    storePath: string,
    lookup: DeliveryLookup,
  ): Promise<DeliveryExactRead> => {
    const batch =
      !lookup.sessionKeys.some(isIncognitoSessionKey) && storePath === lookup.storePaths[0]
        ? firstStoreBatches.get(JSON.stringify([lookup.agentId, storePath]))
        : undefined;
    if (batch && batch.keySets.size > 1) {
      batch.read ??= readSessionEntriesFromStoreInWorker({
        agentId: lookup.agentId,
        storePath,
        sessionKeys: [...batch.keys],
        projection: "list",
        snapshotFields: [],
      })
        .then(({ entries, source }) => ({
          entries: new Map(entries.map((row) => [row.sessionKey, row])),
          source,
        }))
        // One unreadable target must not suppress healthy targets in the same store.
        .catch(() => undefined);
      const combined = await batch.read;
      if (combined) {
        return {
          entries: lookup.exactKeys.flatMap((key) => {
            const row = combined.entries.get(key);
            return row ? [row] : [];
          }),
          source: combined.source,
        };
      }
    }
    return readIndependent(storePath, lookup);
  };
  const indexes = new Map<string, DeliveryStoreRead["foldedSignalIndex"]>();
  for (const { index, sessionKey, baseSessionKey, lookup } of lookups) {
    try {
      const selected = await loadDeliverySessionEntry(lookup, async (storePath) => {
        const read = await readExact(storePath, lookup);
        const source = read.source;
        const indexKey = source ? `${source.agentId}\u0000${source.path}` : storePath;
        let foldedSignalIndex = indexes.get(indexKey);
        if (!foldedSignalIndex) {
          foldedSignalIndex = lazyFoldedSignalIndex(
            source ? { storePath: source.path, agentId: source.agentId } : { storePath },
          );
          indexes.set(indexKey, foldedSignalIndex);
        }
        const entries = new Map(read.entries.map(({ sessionKey: key, entry }) => [key, entry]));
        return { get: (key) => entries.get(key), foldedSignalIndex };
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

function lazyFoldedSignalIndex(scope: {
  storePath: string;
  agentId?: string;
}): DeliveryStoreRead["foldedSignalIndex"] {
  let result: Promise<Map<string, SessionEntry>> | undefined;
  return () =>
    (result ??= readSessionEntrySummariesInWorker(scope).then(buildFoldedSignalSessionEntryIndex));
}

async function findSessionEntryInStore(store: DeliveryStoreRead, keys: readonly string[]) {
  let bestEntry: SessionEntry | undefined;
  let bestUpdatedAt = 0;
  let bestRoutable = false;
  let bestExact = false;
  // Preference order: routable delivery context first; then Matrix/tail-preserved
  // exact keys over folded aliases; then freshness. Signal groups keep their
  // freshest-routable folded-alias behavior.
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
    if (
      !exactKeyWins &&
      normalized.includes(":signal:group:") &&
      (trimmed !== normalized || !foundRoutableCandidate)
    ) {
      // Admitted store keys are canonical. Only Signal's permissive case-folded group aliases
      // can add candidates beyond the keyed reads; Matrix opaque ids never use this index.
      const foldedIndex = await store.foldedSignalIndex();
      acceptCandidate(foldedIndex.get(normalized.toLowerCase()));
    }
  }
  return bestEntry;
}

function buildFoldedSignalSessionEntryIndex(
  entries: readonly SessionEntrySummary[],
): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const { sessionKey, entry } of entries) {
    if (!sessionKey.includes(":signal:group:") || requiresFoldedSessionKeyAliasProof(sessionKey)) {
      continue;
    }
    const key = sessionKey.toLowerCase();
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
  }
  return index;
}

async function loadDeliverySessionEntry(
  lookup: DeliveryLookup,
  readStore: (storePath: string) => Promise<DeliveryStoreRead>,
) {
  let fallback:
    | {
        entry: Awaited<ReturnType<typeof findSessionEntryInStore>>;
        baseEntry: Awaited<ReturnType<typeof findSessionEntryInStore>>;
      }
    | undefined;
  for (const storePath of lookup.storePaths) {
    const store = await readStore(storePath);
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
