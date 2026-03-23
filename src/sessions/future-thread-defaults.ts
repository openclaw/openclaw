import crypto from "node:crypto";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { FutureThreadDefaultsHistoryEntry, SessionEntry } from "../config/sessions.js";
import { applyFutureThreadThinkingLevelOverride } from "./level-overrides.js";
import {
  applyFutureThreadModelDefaultToSessionEntry,
  applyModelOverrideToSessionEntry,
  type FutureThreadModelDefault,
} from "./model-overrides.js";

const MAX_FUTURE_THREAD_HISTORY = 32;

function createFutureThreadParentEntry(): SessionEntry {
  return {
    sessionId: crypto.randomUUID(),
    updatedAt: Date.now(),
  };
}

function normalizeThreadId(value: string | number | undefined | null): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function snapshotFutureThreadDefaults(parentEntry: SessionEntry) {
  const providerOverride = parentEntry.futureThreadProviderOverride?.trim() || undefined;
  const modelOverride = parentEntry.futureThreadModelOverride?.trim() || undefined;
  const thinkingLevelOverride = parentEntry.futureThreadThinkingLevelOverride?.trim() || undefined;
  return {
    providerOverride,
    modelOverride,
    thinkingLevelOverride,
  };
}

function upsertFutureThreadDefaultsHistory(params: {
  parentEntry: SessionEntry;
  afterThreadId: number;
}): boolean {
  const snapshot = snapshotFutureThreadDefaults(params.parentEntry);
  const currentHistory = params.parentEntry.futureThreadDefaultsHistory ?? [];
  const nextEntry: FutureThreadDefaultsHistoryEntry = {
    afterThreadId: params.afterThreadId,
    updatedAt: Date.now(),
    ...snapshot,
  };
  const existingIndex = currentHistory.findIndex(
    (entry) => entry.afterThreadId === params.afterThreadId,
  );

  // Keep one snapshot per boundary thread id. Rewriting the same boundary is
  // expected when /model and /think are changed separately inside one topic.
  if (existingIndex >= 0) {
    const existing = currentHistory[existingIndex];
    if (
      existing.providerOverride === nextEntry.providerOverride &&
      existing.modelOverride === nextEntry.modelOverride &&
      existing.thinkingLevelOverride === nextEntry.thinkingLevelOverride
    ) {
      return false;
    }
    const nextHistory = currentHistory.slice();
    nextHistory[existingIndex] = nextEntry;
    params.parentEntry.futureThreadDefaultsHistory = nextHistory;
    return true;
  }

  const nextHistory = [...currentHistory, nextEntry]
    .toSorted((left, right) => left.afterThreadId - right.afterThreadId)
    .slice(-MAX_FUTURE_THREAD_HISTORY);
  params.parentEntry.futureThreadDefaultsHistory = nextHistory;
  return true;
}

function resolveHistoricalFutureThreadDefaults(params: {
  parentEntry: SessionEntry;
  childThreadId?: string | number | null;
}) {
  const childThreadId = normalizeThreadId(params.childThreadId);
  const history = params.parentEntry.futureThreadDefaultsHistory;
  if (!childThreadId || !Array.isArray(history) || history.length === 0) {
    return snapshotFutureThreadDefaults(params.parentEntry);
  }

  let match: FutureThreadDefaultsHistoryEntry | undefined;
  for (const entry of history) {
    if (entry.afterThreadId < childThreadId) {
      match = entry;
      continue;
    }
    break;
  }

  // If the child topic/thread predates every recorded future-thread change, it
  // must not retroactively inherit today's parent defaults.
  if (!match) {
    return {
      providerOverride: undefined,
      modelOverride: undefined,
      thinkingLevelOverride: undefined,
    };
  }

  return {
    providerOverride: match.providerOverride?.trim() || undefined,
    modelOverride: match.modelOverride?.trim() || undefined,
    thinkingLevelOverride: match.thinkingLevelOverride?.trim() || undefined,
  };
}

// Keep Telegram thread/topic inheritance on one code path so topic-create
// seeding and first-message seeding cannot drift on model vs thinking behavior.
export function seedSessionEntryFromFutureThreadDefaults(params: {
  entry: SessionEntry;
  parentEntry?: SessionEntry;
  childThreadId?: string | number | null;
}): { updated: boolean } {
  const { entry, parentEntry } = params;
  if (!parentEntry) {
    return { updated: false };
  }

  let updated = false;
  const snapshot = resolveHistoricalFutureThreadDefaults({
    parentEntry,
    childThreadId: params.childThreadId,
  });
  const parentProvider = snapshot.providerOverride;
  const parentModel = snapshot.modelOverride;
  const parentThinkingLevel = snapshot.thinkingLevelOverride;

  if (parentProvider && parentModel && !entry.providerOverride && !entry.modelOverride) {
    updated =
      applyModelOverrideToSessionEntry({
        entry,
        selection: {
          provider: parentProvider,
          model: parentModel,
        },
      }).updated || updated;
  }

  if (parentThinkingLevel && !entry.thinkingLevel) {
    entry.thinkingLevel = parentThinkingLevel;
    entry.updatedAt = Date.now();
    updated = true;
  }

  return { updated };
}

export function applyFutureThreadModelDefault(params: {
  store: Record<string, SessionEntry>;
  parentSessionKey: string;
  selection: FutureThreadModelDefault;
  afterThreadId?: string | number | null;
}): { updated: boolean; parentEntry: SessionEntry } {
  const parentEntry = params.store[params.parentSessionKey] ?? createFutureThreadParentEntry();
  const result = applyFutureThreadModelDefaultToSessionEntry({
    entry: parentEntry,
    selection: params.selection,
  });
  const historyUpdated =
    normalizeThreadId(params.afterThreadId) != null
      ? upsertFutureThreadDefaultsHistory({
          parentEntry,
          afterThreadId: normalizeThreadId(params.afterThreadId)!,
        })
      : false;
  if (result.updated || historyUpdated) {
    params.store[params.parentSessionKey] = parentEntry;
  }
  return { updated: result.updated || historyUpdated, parentEntry };
}

export function applyFutureThreadThinkingDefault(params: {
  store: Record<string, SessionEntry>;
  parentSessionKey: string;
  level: ThinkLevel;
  afterThreadId?: string | number | null;
}): { updated: boolean; parentEntry: SessionEntry } {
  const parentEntry = params.store[params.parentSessionKey] ?? createFutureThreadParentEntry();
  const result = applyFutureThreadThinkingLevelOverride(parentEntry, params.level);
  const historyUpdated =
    normalizeThreadId(params.afterThreadId) != null
      ? upsertFutureThreadDefaultsHistory({
          parentEntry,
          afterThreadId: normalizeThreadId(params.afterThreadId)!,
        })
      : false;
  if (result.updated || historyUpdated) {
    params.store[params.parentSessionKey] = parentEntry;
  }
  return { updated: result.updated || historyUpdated, parentEntry };
}
