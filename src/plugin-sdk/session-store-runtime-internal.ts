import { MAIN_SESSION_RECOVERY_CLEAR_PATCH } from "../agents/main-session-recovery/main-session-recovery-clear.js";
import type { SessionAccessScope } from "../config/sessions/session-accessor.js";
import {
  projectPublicSessionEntry,
  SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
} from "../config/sessions/session-entry-projection.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";

export type SessionStoreReadParams = {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  hydrateSkillPromptRefs?: boolean;
  readConsistency?: "latest";
  sessionKey: string;
  storePath?: string;
};

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

export function preserveGenerationPrivateFields(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  if (
    (Object.hasOwn(publicPatch, "sessionId") &&
      publicPatch.sessionId !== existingEntry.sessionId) ||
    (Object.hasOwn(publicPatch, "lifecycleRevision") &&
      publicPatch.lifecycleRevision !== existingEntry.lifecycleRevision)
  ) {
    return {
      ...publicPatch,
      ...SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
      ...MAIN_SESSION_RECOVERY_CLEAR_PATCH,
    };
  }
  const state: Partial<InternalSessionEntry> = {
    ...(existingEntry.cliHistoryBoundary
      ? { cliHistoryBoundary: existingEntry.cliHistoryBoundary }
      : {}),
    ...(existingEntry.activeWriterRunId !== undefined
      ? { activeWriterRunId: existingEntry.activeWriterRunId }
      : {}),
    ...(existingEntry.lifecycleRunId !== undefined
      ? { lifecycleRunId: existingEntry.lifecycleRunId }
      : {}),
    ...(existingEntry.pendingProjectGitUrl !== undefined
      ? { pendingProjectGitUrl: existingEntry.pendingProjectGitUrl }
      : {}),
    ...(existingEntry.transcriptByteCompactionLatch
      ? { transcriptByteCompactionLatch: existingEntry.transcriptByteCompactionLatch }
      : {}),
    ...(existingEntry.sessionDiffBaselineCapture
      ? { sessionDiffBaselineCapture: existingEntry.sessionDiffBaselineCapture }
      : {}),
    ...(existingEntry.mainRestartRecovery
      ? {
          abortedLastRun: existingEntry.abortedLastRun,
          restartRecoveryRuns: existingEntry.restartRecoveryRuns,
          mainRestartRecovery: existingEntry.mainRestartRecovery,
        }
      : {}),
  };
  return Object.keys(state).length > 0
    ? {
        ...publicPatch,
        ...(!Object.hasOwn(publicPatch, "lifecycleRevision") &&
        existingEntry.lifecycleRevision !== undefined
          ? { lifecycleRevision: existingEntry.lifecycleRevision }
          : {}),
        ...state,
      }
    : publicPatch;
}
