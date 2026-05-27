import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { readSessionStoreSnapshot } from "./store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import type { SessionEntry } from "./types.js";
export { parseSessionThreadInfo };

function hasRoutableDeliveryContext(context?: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}): context is {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
} {
  return Boolean(context?.channel && context?.to);
}

export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  try {
    const cfg = options?.cfg ?? getRuntimeConfig();
    const lookup = loadDeliverySessionEntry({ cfg, sessionKey, baseSessionKey });
    let entry = lookup.entry;
    let storedDeliveryContext = deliveryContextFromSession(entry);
    if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
      entry = lookup.baseEntry;
      storedDeliveryContext = deliveryContextFromSession(entry);
    }
    if (hasRoutableDeliveryContext(storedDeliveryContext)) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId: storedDeliveryContext.threadId,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
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

function asSessionEntry(entry: unknown): SessionEntry | undefined {
  return entry as SessionEntry | undefined;
}

// Extract the Matrix room id from a `:matrix:channel:<room>[:thread:...]` session key
// or a `room:<room>` delivery target. Empty when there is no Matrix room component.
// Matrix room ids are opaque + case-sensitive, so callers compare these for exact equality.
function matrixRoomIdOf(value: string): string {
  const MARK = ":matrix:channel:";
  let s = value;
  const i = s.indexOf(MARK);
  if (i !== -1) {
    s = s.slice(i + MARK.length);
  } else if (s.startsWith("room:")) {
    s = s.slice("room:".length);
  } else {
    return "";
  }
  const t = s.indexOf(":thread:");
  return (t === -1 ? s : s.slice(0, t)).trim();
}

function findSessionEntryInStore(
  store: ReturnType<typeof readSessionStoreSnapshot>,
  keys: readonly string[],
) {
  let normalizedIndex: Map<string, SessionEntry> | undefined;
  let bestEntry: SessionEntry | undefined;
  let bestUpdatedAt = 0;
  let bestRoutable = false;
  let bestExact = false;
  // Preference order: routable delivery context first; then an exact mixed-case
  // (opaque-preserving-normalized) key over a folded legacy alias (openclaw#75670);
  // then freshness. Exact ranks below routability so delivery correctness still wins.
  const acceptCandidate = (candidate: unknown, isExact = false) => {
    if (!candidate) {
      return;
    }
    const entry = candidate as SessionEntry;
    const candidateRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
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
  // A folded (lowercase) candidate is this room's lowercased artifact — eligible for
  // the migration read — only if its delivery target is this room's real mixed-case
  // id. A genuinely case-distinct sibling that merely folds to the same lowercase is
  // rejected, so it can't cross-contaminate the lookup (openclaw#87366 codex review).
  const deliveryRoomOf = (candidate: unknown): string =>
    matrixRoomIdOf(deliveryContextFromSession(candidate as SessionEntry | undefined)?.to ?? "");
  const foldedDeliversToRoom = (candidate: unknown, normalizedKey: string): boolean => {
    const reqRoom = matrixRoomIdOf(normalizedKey);
    // Non-Matrix keys (e.g. Signal groups) keep the prior permissive folded-migration
    // behavior; the case-distinct guard is Matrix-room-specific (openclaw#87366).
    if (reqRoom.length === 0) {
      return true;
    }
    return deliveryRoomOf(candidate) === reqRoom;
  };
  // True when a candidate's delivery room folds to the requested room but differs in
  // case — a mislabeled lowercased artifact for a DIFFERENT-cased request. Accepting it
  // would leak a case-distinct room, so callers skip such candidates (openclaw#87366).
  const deliveryRoomCaseMismatch = (candidate: unknown, normalizedKey: string): boolean => {
    const reqRoom = matrixRoomIdOf(normalizedKey);
    const delRoom = deliveryRoomOf(candidate);
    return (
      reqRoom.length > 0 &&
      delRoom.length > 0 &&
      delRoom !== reqRoom &&
      delRoom.toLowerCase() === reqRoom.toLowerCase()
    );
  };
  for (const key of keys) {
    const trimmed = key.trim();
    const normalized = normalizeStoreSessionKey(key);
    const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
    let foundRoutableCandidate = false;
    if (
      Object.prototype.hasOwnProperty.call(store, normalized) &&
      !deliveryRoomCaseMismatch(store[normalized], normalized)
    ) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(asSessionEntry(store[normalized])),
      );
      acceptCandidate(store[normalized], /* isExact */ true);
    }
    if (
      foldedLegacyKey !== normalized &&
      Object.prototype.hasOwnProperty.call(store, foldedLegacyKey) &&
      foldedDeliversToRoom(store[foldedLegacyKey], normalized)
    ) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(asSessionEntry(store[foldedLegacyKey])),
      );
      acceptCandidate(store[foldedLegacyKey]);
    }
    if (
      trimmed !== normalized &&
      Object.prototype.hasOwnProperty.call(store, trimmed) &&
      !deliveryRoomCaseMismatch(store[trimmed], normalized)
    ) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(asSessionEntry(store[trimmed])),
      );
      acceptCandidate(store[trimmed]);
    }
    if (trimmed !== normalized || !foundRoutableCandidate) {
      normalizedIndex ??= buildFreshestSessionEntryIndex(store);
      const freshest = normalizedIndex.get(normalized);
      if (!deliveryRoomCaseMismatch(freshest, normalized)) {
        acceptCandidate(freshest);
      }
      if (foldedLegacyKey !== normalized) {
        const foldedFreshest = normalizedIndex.get(foldedLegacyKey);
        if (foldedDeliversToRoom(foldedFreshest, normalized)) {
          acceptCandidate(foldedFreshest);
        }
      }
    }
  }
  return bestEntry;
}

function buildFreshestSessionEntryIndex(
  store: Readonly<Record<string, unknown>>,
): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const [key, candidate] of Object.entries(store)) {
    const entry = asSessionEntry(candidate);
    if (!entry) {
      continue;
    }
    const normalized = normalizeStoreSessionKey(key);
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
    // NOTE: entries are indexed ONLY under their exact opaque-preserving normalized
    // key — never under the folded lowercase key. Indexing under the fold let a
    // case-distinct room be returned for a different room's lookup (openclaw#87366
    // codex review). Folded migration reads are handled explicitly + delivery-gated
    // in findSessionEntryInStore.
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
    const store = readSessionStoreSnapshot(storePath);
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
