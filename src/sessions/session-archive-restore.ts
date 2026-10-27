import { isRestartRecoveryTombstone } from "../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { SessionWorkStartChangedError } from "../config/sessions/work-start-error.js";
import {
  prepareSessionWorkerPlacementMutationCheckAsync,
  readSessionWorkerPlacementAsync,
  resolveWorkerPlacementArchiveRestoreError,
  type SessionWorkerPlacementContext,
} from "../gateway/worker-environments/session-placement-lifecycle.js";
import { runSessionMutation } from "./session-controller.lifecycle.js";

/** Restore the selected archived generation after the caller authorizes human work. */
export async function restoreArchivedSession(params: {
  assertCurrent: SessionSourceAssertion;
  entry: SessionEntry;
  agentId?: string;
  placementContext?: SessionWorkerPlacementContext;
  sessionKey: string;
  storePath: string;
}): Promise<SessionEntry | undefined> {
  const { entry, sessionKey, storePath } = params;
  if (entry.archivedAt === undefined || isRestartRecoveryTombstone(entry)) {
    return entry;
  }
  const scope = { agentId: params.agentId, sessionKey, storePath };
  const metadata = captureSessionEntryMetadataRead(scope, params.assertCurrent);
  let placementContext = params.placementContext;
  if (!placementContext) {
    try {
      placementContext = (
        await import("../gateway/session-worker-placement-context.js")
      ).resolveSessionWorkerPlacementContext();
    } catch {
      return entry;
    }
  }
  const snapshotSessionId = entry.sessionId;
  const snapshotArchivedAt = entry.archivedAt;
  const snapshotLifecycleRevision = entry.lifecycleRevision;
  const canRestore = (
    currentEntry: SessionEntry,
    prepared?: { placement: Awaited<ReturnType<typeof readSessionWorkerPlacementAsync>> },
  ) => {
    if (
      currentEntry.sessionId !== snapshotSessionId ||
      currentEntry.archivedAt !== snapshotArchivedAt ||
      currentEntry.lifecycleRevision !== snapshotLifecycleRevision ||
      isRestartRecoveryTombstone(currentEntry)
    ) {
      return false;
    }
    try {
      const placement = prepared
        ? prepared.placement
        : currentEntry.sessionId
          ? placementContext.workerSessionPlacementService
              ?.getMany([currentEntry.sessionId])
              .get(currentEntry.sessionId)
          : undefined;
      return !resolveWorkerPlacementArchiveRestoreError({
        context: placementContext,
        key: sessionKey,
        placement,
      });
    } catch {
      return false;
    }
  };
  return await runSessionMutation({
    scope: storePath,
    identities: [sessionKey, snapshotSessionId],
    run: async () => {
      const currentEntry = metadata
        ? metadata.readCurrent()
        : await readSessionEntryReadOnlyInWorker(scope);
      if (
        !currentEntry ||
        !canRestore(currentEntry, {
          placement: await readSessionWorkerPlacementAsync({
            context: placementContext,
            sessionId: currentEntry.sessionId,
          }),
        })
      ) {
        return currentEntry;
      }
      let assertCommitAllowed: SessionSourceAssertion | undefined = metadata
        ? () => {
            const current = metadata.readCurrent();
            if (!current || !canRestore(current)) {
              throw new SessionWorkStartChangedError(
                "Session changed while restoring archived work. Retry the request.",
              );
            }
          }
        : undefined;
      assertCommitAllowed = composeSessionSourceAssertion([
        params.assertCurrent,
        assertCommitAllowed,
      ]);
      if (currentEntry.worktree) {
        const { restoreSessionWorktree } = await import("./session-worktree-lifecycle.js");
        // Keep the target fenced through Git/allocation waits without retaining the agent writer.
        assertCommitAllowed = await restoreSessionWorktree({
          entry: currentEntry,
          scope,
          commitGuard: composeSessionSourceAssertion([
            assertCommitAllowed,
            await prepareSessionWorkerPlacementMutationCheckAsync({
              context: placementContext,
              sessionId: currentEntry.sessionId,
            }),
          ]),
        });
      }
      const updatedEntry = await patchSessionEntryCore(
        scope,
        (current) =>
          canRestore(current)
            ? { archivedAt: undefined, archivedBy: undefined, archiveReason: undefined }
            : null,
        // The writer may have waited; revalidate the prepared binding at the actual commit edge.
        sessionEntryCommitGuardOptions(assertCommitAllowed),
      );
      return updatedEntry ?? undefined;
    },
  });
}
