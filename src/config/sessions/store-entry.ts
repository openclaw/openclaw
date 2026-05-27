import { normalizeSessionKeyPreservingOpaquePeerIds } from "../../sessions/session-key-utils.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import type { SessionEntry } from "./types.js";

export function normalizeStoreSessionKey(sessionKey: string): string {
  return normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
}

/** The case-sensitive room/peer target an entry actually delivers to. Delivery
 *  metadata preserves the real opaque id even when the session KEY was lowercased
 *  by the bug, so it distinguishes a lowercased artifact from a distinct room. */
function entryDeliveryTarget(entry: SessionEntry | undefined): string {
  const to = entry?.deliveryContext?.to ?? entry?.lastTo;
  return typeof to === "string" ? to.replace(/^room:/, "").trim() : "";
}

/** A folded (lowercased-key) entry is the lowercased ARTIFACT of `normalizedKey`
 *  — safe to collapse/delete on write — only if it still delivers to the real
 *  mixed-case opaque id embedded in `normalizedKey`. A genuinely case-distinct
 *  room delivers to its own differently-cased id, so this returns false and the
 *  sibling session is preserved (openclaw#75670 review: never delete case-distinct
 *  Matrix sessions). Absent/unconfirmed delivery target → preserve (return false). */
function isLowercasedLegacyAlias(entry: SessionEntry | undefined, normalizedKey: string): boolean {
  const target = entryDeliveryTarget(entry);
  return target.length > 0 && normalizedKey.includes(target);
}

export function resolveSessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
}): {
  normalizedKey: string;
  existing: SessionEntry | undefined;
  legacyKeys: string[];
} {
  const trimmedKey = params.sessionKey.trim();
  const normalizedKey = normalizeStoreSessionKey(trimmedKey);
  const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalizedKey);
  const legacyKeySet = new Set<string>();
  if (
    trimmedKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, trimmedKey)
  ) {
    legacyKeySet.add(trimmedKey);
  }
  // The folded lowercase key is treated as a legacy alias of THIS room — for both
  // collapse-on-write AND the read fallback — ONLY when confirmed to be the
  // lowercased artifact of this room (its delivery target is this room's real
  // mixed-case id). A case-distinct sibling that merely folds to the same lowercase
  // is neither deleted nor returned as the existing session, so its state can't
  // leak into this room (openclaw#75670 review: never cross-contaminate
  // case-distinct Matrix sessions).
  const foldedLegacyEntry =
    foldedLegacyKey !== normalizedKey &&
    Object.prototype.hasOwnProperty.call(params.store, foldedLegacyKey) &&
    isLowercasedLegacyAlias(params.store[foldedLegacyKey], normalizedKey)
      ? params.store[foldedLegacyKey]
      : undefined;
  if (foldedLegacyEntry) {
    legacyKeySet.add(foldedLegacyKey);
  }
  // An exact (opaque-preserving-normalized) entry always wins over any folded
  // legacy alias, regardless of freshness (openclaw#75670). Only when no exact
  // entry exists do we fall back to a confirmed legacy alias.
  const hasExactEntry = Object.prototype.hasOwnProperty.call(params.store, normalizedKey);
  let existing =
    params.store[normalizedKey] ??
    foldedLegacyEntry ??
    (legacyKeySet.size > 0 ? params.store[trimmedKey] : undefined);
  let existingUpdatedAt = existing?.updatedAt ?? 0;
  for (const [candidateKey, candidateEntry] of Object.entries(params.store)) {
    if (candidateKey === normalizedKey) {
      continue;
    }
    // Only collapse TRUE canonical aliases (same opaque-preserving key, e.g. a
    // structural-token-case variant). Do NOT collapse keys that merely fold to the
    // same lowercase — those can be case-distinct Matrix rooms that must survive.
    if (normalizeStoreSessionKey(candidateKey) !== normalizedKey) {
      continue;
    }
    legacyKeySet.add(candidateKey);
    if (hasExactEntry) {
      // Keep collecting legacy aliases for write-time collapse, but never let a
      // fresher legacy entry override the exact mixed-case entry.
      continue;
    }
    const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
    if (!existing || candidateUpdatedAt > existingUpdatedAt) {
      existing = candidateEntry;
      existingUpdatedAt = candidateUpdatedAt;
    }
  }
  return {
    normalizedKey,
    existing,
    legacyKeys: [...legacyKeySet],
  };
}
