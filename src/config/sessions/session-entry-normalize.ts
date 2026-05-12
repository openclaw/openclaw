import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

type LegacySessionShadows = {
  origin?: unknown;
  lastChannel?: unknown;
  lastTo?: unknown;
  lastAccountId?: unknown;
  lastThreadId?: unknown;
};

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const legacyEntry = entry as SessionEntry & LegacySessionShadows;
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const hasLegacyShadows =
    legacyEntry.lastChannel !== undefined ||
    legacyEntry.lastTo !== undefined ||
    legacyEntry.lastAccountId !== undefined ||
    legacyEntry.lastThreadId !== undefined;
  if (sameDelivery && !hasLegacyShadows) {
    return entry;
  }
  const {
    lastChannel: _lastChannel,
    lastTo: _lastTo,
    lastAccountId: _lastAccountId,
    lastThreadId: _lastThreadId,
    ...rest
  } = legacyEntry;
  return {
    ...rest,
    deliveryContext: nextDelivery,
  };
}

// resolvedSkills carries the full parsed Skill[] (including each SKILL.md body)
// and is only used as an in-turn cache by the runtime — see
// src/agents/pi-embedded-runner/skills-runtime.ts. Persisting it bloats session
// rows by orders of magnitude when many sessions are active.
function stripPersistedSkillsCache(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot || snapshot.resolvedSkills === undefined) {
    return entry;
  }
  const { resolvedSkills: _drop, ...rest } = snapshot;
  return { ...entry, skillsSnapshot: rest };
}

function stripPersistedShadows(entry: SessionEntry & LegacySessionShadows): SessionEntry {
  if (entry.origin === undefined) {
    return entry;
  }
  const { origin: _drop, ...rest } = entry;
  return rest;
}

export function normalizeSessionEntries(entries: Record<string, SessionEntry>): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(entries)) {
    if (!entry) {
      continue;
    }
    const normalized = stripPersistedShadows(
      stripPersistedSkillsCache(
        normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry)),
      ),
    );
    if (normalized !== entry) {
      entries[key] = normalized;
      changed = true;
    }
  }
  return changed;
}
