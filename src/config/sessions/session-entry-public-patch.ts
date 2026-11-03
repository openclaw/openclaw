import { SESSION_ENTRY_PRIVATE_CLEAR_PATCH } from "./session-entry-projection.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

function generationValidPrivateFieldsForSameSession(
  existingEntry: InternalSessionEntry | undefined,
  nextSessionId: string | undefined,
  nextLifecycleRevision: string | undefined,
): Partial<InternalSessionEntry> | undefined {
  if (
    !existingEntry ||
    existingEntry.sessionId !== nextSessionId ||
    existingEntry.lifecycleRevision !== nextLifecycleRevision
  ) {
    return undefined;
  }
  const state: Partial<InternalSessionEntry> = {
    ...(existingEntry.localWorkspaceHandoff
      ? { localWorkspaceHandoff: existingEntry.localWorkspaceHandoff }
      : {}),
    ...(existingEntry.priorWorkspace ? { priorWorkspace: existingEntry.priorWorkspace } : {}),
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
    ...(existingEntry.resumeAfterRestart
      ? { resumeAfterRestart: existingEntry.resumeAfterRestart }
      : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

function clearGenerationPrivateFieldsForRotatedSessionPatch(
  existingEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  return (Object.hasOwn(publicPatch, "sessionId") &&
    publicPatch.sessionId !== existingEntry.sessionId) ||
    (Object.hasOwn(publicPatch, "lifecycleRevision") &&
      publicPatch.lifecycleRevision !== existingEntry.lifecycleRevision)
    ? {
        ...publicPatch,
        ...SESSION_ENTRY_PRIVATE_CLEAR_PATCH,
      }
    : publicPatch;
}

export function preserveGenerationPrivateFields(
  persistedEntry: InternalSessionEntry,
  publicPatch: Partial<SessionEntry>,
): Partial<InternalSessionEntry> {
  const nextSessionId = Object.hasOwn(publicPatch, "sessionId")
    ? publicPatch.sessionId
    : persistedEntry.sessionId;
  const nextLifecycleRevision = Object.hasOwn(publicPatch, "lifecycleRevision")
    ? publicPatch.lifecycleRevision
    : persistedEntry.lifecycleRevision;
  const privateFields = generationValidPrivateFieldsForSameSession(
    persistedEntry,
    nextSessionId,
    nextLifecycleRevision,
  );
  return privateFields
    ? {
        ...publicPatch,
        ...(!Object.hasOwn(publicPatch, "lifecycleRevision") &&
        persistedEntry.lifecycleRevision !== undefined
          ? { lifecycleRevision: persistedEntry.lifecycleRevision }
          : {}),
        ...privateFields,
      }
    : clearGenerationPrivateFieldsForRotatedSessionPatch(persistedEntry, publicPatch);
}
