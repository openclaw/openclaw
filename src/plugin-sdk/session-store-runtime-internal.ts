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
  return entry ? projectPluginSessionEntry(entry) : undefined;
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

export { projectPublicSessionEntryPatch as projectPluginSessionEntryPatch } from "../config/sessions/session-entry-projection.js";
