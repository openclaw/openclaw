import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readSqliteSessionDeliveryContext } from "./session-entries.sqlite.js";
import { parseSessionThreadInfo } from "./thread-info.js";

export { parseSessionThreadInfo };

type DeliveryContextInfo = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
};

function hasRoutableDeliveryContext(
  context: DeliveryContextInfo | undefined,
): context is DeliveryContextInfo & { channel: string; to: string } {
  return Boolean(context?.channel && context?.to);
}

export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): {
  deliveryContext: DeliveryContextInfo | undefined;
  threadId: string | undefined;
} {
  void options;
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext: DeliveryContextInfo | undefined;
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const direct = readSqliteSessionDeliveryContext({ agentId, sessionKey });
    const base =
      !hasRoutableDeliveryContext(direct) && baseSessionKey !== sessionKey
        ? readSqliteSessionDeliveryContext({ agentId, sessionKey: baseSessionKey })
        : undefined;
    const stored = hasRoutableDeliveryContext(direct) ? direct : base;
    if (hasRoutableDeliveryContext(stored)) {
      deliveryContext = {
        channel: stored.channel,
        to: stored.to,
        accountId: stored.accountId,
        threadId: stored.threadId,
      };
    }
  } catch {
    // ignore: best-effort
  }

  return {
    deliveryContext,
    threadId: deliveryContext?.threadId ?? threadId,
  };
}

function resolveDeliveryStorePaths(cfg: OpenClawConfig, agentId: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveStorePath(cfg.session?.store, { agentId }));
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      paths.add(target.storePath);
    }
  }
  return [...paths];
}

function findSessionEntryInStore(
  store: ReturnType<typeof loadSessionStore>,
  keys: readonly string[],
) {
  let normalizedIndex: Map<string, SessionEntry> | undefined;
  let bestEntry: SessionEntry | undefined;
  let bestUpdatedAt = 0;
  let bestRoutable = false;
  const acceptCandidate = (candidate: SessionEntry | undefined) => {
    if (!candidate) {
      return;
    }
    const candidateRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(candidate));
    const candidateUpdatedAt = candidate.updatedAt ?? 0;
    if (
      !bestEntry ||
      (candidateRoutable && !bestRoutable) ||
      (candidateRoutable === bestRoutable && candidateUpdatedAt > bestUpdatedAt)
    ) {
      bestEntry = candidate;
      bestUpdatedAt = candidateUpdatedAt;
      bestRoutable = candidateRoutable;
    }
  };
  for (const key of keys) {
    const trimmed = key.trim();
    const normalized = normalizeLowercaseStringOrEmpty(key);
    let foundRoutableCandidate = false;
    if (Object.prototype.hasOwnProperty.call(store, normalized)) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(store[normalized]),
      );
      acceptCandidate(store[normalized]);
    }
    if (trimmed !== normalized && Object.prototype.hasOwnProperty.call(store, trimmed)) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(store[trimmed]),
      );
      acceptCandidate(store[trimmed]);
    }
    if (trimmed !== normalized || !foundRoutableCandidate) {
      normalizedIndex ??= buildFreshestSessionEntryIndex(store);
      const freshest = normalizedIndex.get(normalized);
      acceptCandidate(freshest);
    }
  }
  return bestEntry;
}

function buildFreshestSessionEntryIndex(
  store: Record<string, SessionEntry>,
): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const [key, entry] of Object.entries(store)) {
    const normalized = normalizeLowercaseStringOrEmpty(key);
    const existing = index.get(normalized);
    const entryRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
    const existingRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(existing));
    if (
      !existing ||
      (entryRoutable && !existingRoutable) ||
      (entryRoutable === existingRoutable && (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0))
    ) {
      index.set(normalized, entry);
    }
  }
  return index;
}

function loadDeliverySessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  baseSessionKey: string;
}) {
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const canonicalBaseKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.baseSessionKey,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const sessionKeys = [params.sessionKey, canonicalKey];
  const baseKeys = [params.baseSessionKey, canonicalBaseKey];
  let fallback:
    | {
        entry: ReturnType<typeof findSessionEntryInStore>;
        baseEntry: ReturnType<typeof findSessionEntryInStore>;
      }
    | undefined;
  for (const storePath of resolveDeliveryStorePaths(params.cfg, agentId)) {
    const store = loadSessionStore(storePath);
    const entry = findSessionEntryInStore(store, sessionKeys);
    const baseEntry = findSessionEntryInStore(store, baseKeys);
    if (!entry && !baseEntry) {
      continue;
    }
    fallback ??= { entry, baseEntry };
    if (
      hasRoutableDeliveryContext(deliveryContextFromSession(entry)) ||
      hasRoutableDeliveryContext(deliveryContextFromSession(baseEntry))
    ) {
      return { entry, baseEntry };
    }
  }
  return fallback ?? { entry: undefined, baseEntry: undefined };
}
