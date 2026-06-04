import type { SkillEntry } from "../agents/skills/types.js";

// Leaf contract for the DB-skills sync cache. Kept free of config/runtime
// imports so prompt-assembly code (agents/skills/workspace.ts) can read the
// cache without creating an import cycle back through config -> skills-mysql.

let syncCache: SkillEntry[] | null = null;
let cachedUserId: number | undefined = undefined;

/** Replace the cached DB skill entries (written by skills-mysql loaders). */
export function setSkillsDbCache(entries: SkillEntry[] | null, userId?: number): void {
  syncCache = entries;
  cachedUserId = userId;
}

/** User id the current cache was loaded for, if any. */
export function getSkillsDbCachedUserId(): number | undefined {
  return cachedUserId;
}

/** Sync read of the cached DB skill entries; empty until a loader primes it. */
export function loadSkillEntriesFromDb(_userId?: string): SkillEntry[] {
  return syncCache ?? [];
}
