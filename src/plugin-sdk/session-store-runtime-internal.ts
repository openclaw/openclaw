import type { SessionAccessScope } from "../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import {
  readSessionEntryByIdReadOnlyInWorker,
  readSessionEntryReadOnlyInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";

export type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

export type SessionStoreEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

/** Loads the complete public entry through the selected asynchronous read owner. */
export async function getSessionEntryAsync(
  params: SessionStoreReadParams,
): Promise<SessionEntry | undefined> {
  const entry = await readSessionEntryReadOnlyInWorker(toSessionAccessScope(params));
  // The public read owns its mutable result; internal actor readers borrow committed facts.
  return entry ? structuredClone(projectPluginSessionEntry(entry)) : undefined;
}

/** Looks up a visible current session ID in one selected store. */
export async function getSessionEntryByIdAsync(
  params: Omit<SessionStoreReadParams, "sessionKey"> & {
    sessionId: string;
    /** Newest normalized-ID match; omitted preserves exact-ID-first listing order. */
    orderBy?: "updatedAt";
  },
): Promise<SessionStoreEntrySummary | undefined> {
  const selected = await readSessionEntryByIdReadOnlyInWorker({
    ...toSessionAccessScope({ ...params, sessionKey: "" }),
    sessionId: params.sessionId,
    orderBy: params.orderBy,
  });
  return selected
    ? { sessionKey: selected.sessionKey, entry: projectPluginSessionEntry(selected.entry) }
    : undefined;
}

export function toSessionAccessScope(params: SessionStoreReadParams): SessionAccessScope {
  // Keep plugin-facing options separate from internal accessor-only controls.
  return {
    sessionKey: params.sessionKey,
    ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
    ...(params.env !== undefined ? { env: params.env } : {}),
    ...(params.hydrateSkillPromptRefs !== undefined
      ? { hydrateSkillPromptRefs: params.hydrateSkillPromptRefs }
      : {}),
    ...(params.readConsistency !== undefined ? { readConsistency: params.readConsistency } : {}),
    ...(params.storePath !== undefined ? { storePath: params.storePath } : {}),
  };
}

export function projectPluginSessionEntry(entry: InternalSessionEntry): SessionEntry {
  const publicEntry = projectPublicSessionEntry(entry);
  return {
    ...publicEntry,
    ...(entry.restartRecoveryRuns
      ? { restartRecoveryRuns: entry.restartRecoveryRuns.map((run) => ({ ...run })) }
      : {}),
  };
}

// Public results own their containers; immutable prompt strings can remain shared.
export function copyMutableSessionEntry<T extends InternalSessionEntry | null>(entry: T): T {
  if (!entry) {
    return entry;
  }
  const copied = { ...entry };
  const pending: object[] = [copied];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const key of Object.keys(parent)) {
      const value: unknown = Reflect.get(parent, key);
      if (value === null || typeof value !== "object") {
        continue;
      }
      const child = Array.isArray(value) ? [...value] : { ...value };
      Reflect.set(parent, key, child);
      pending.push(child);
    }
  }
  return copied;
}

export { projectPublicSessionEntryPatch as projectPluginSessionEntryPatch } from "../config/sessions/session-entry-projection.js";

/** Read-only lifecycle intent for channel-owned title writers; no private counter exposure. */
export async function getSessionTitleLifecycleAsync(params: SessionStoreReadParams) {
  const entry = await readSessionEntryReadOnlyInWorker(toSessionAccessScope(params));
  return entry
    ? {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        resetMode: entry.titleRefinement?.resetMode,
        explicitLabel: entry.label,
      }
    : undefined;
}
