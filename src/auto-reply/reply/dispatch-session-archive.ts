import { isRestartRecoveryTombstone } from "../../config/sessions/lifecycle.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import {
  composeSessionSourceAssertion,
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  prepareSessionWorkerPlacementMutationCheckAsync,
  readSessionWorkerPlacementAsync,
  resolveWorkerPlacementArchiveRestoreError,
  type SessionWorkerPlacementContext,
} from "../../gateway/worker-environments/session-placement-lifecycle.js";
import { runSessionMutation } from "../../sessions/session-controller.lifecycle.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import { isNativeCommandTurn } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";

export async function restoreArchivedDispatchSession(params: {
  assertCurrent: () => void;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  hasPluginOwnedBinding: boolean;
  placementContext?: SessionWorkerPlacementContext;
  sessionKey?: string;
  storePath?: string;
}): Promise<SessionEntry | undefined> {
  const { ctx, entry, hasPluginOwnedBinding, sessionKey, storePath } = params;
  if (
    !entry ||
    !sessionKey ||
    !storePath ||
    entry.archivedAt === undefined ||
    isRestartRecoveryTombstone(entry) ||
    hasPluginOwnedBinding ||
    ctx.InboundAccessAuthorized !== true ||
    ctx.InboundEventKind === "room_event" ||
    isNativeCommandTurn(ctx.CommandTurn) ||
    classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType !== "human"
  ) {
    return entry;
  }
  const scope = { sessionKey, storePath };
  const metadata = captureSessionEntryMetadataRead(scope, params.assertCurrent);
  let placementContext = params.placementContext;
  if (!placementContext) {
    try {
      placementContext = (
        await import("../../gateway/session-worker-placement-context.js")
      ).resolveSessionWorkerPlacementContext();
    } catch {
      return entry;
    }
  }
  const snapshotSessionId = entry.sessionId;
  const snapshotArchivedAt = entry.archivedAt;
  const canRestore = (
    currentEntry: SessionEntry,
    prepared?: { placement: Awaited<ReturnType<typeof readSessionWorkerPlacementAsync>> },
  ) => {
    if (
      currentEntry.sessionId !== snapshotSessionId ||
      currentEntry.archivedAt !== snapshotArchivedAt ||
      (metadata && currentEntry.lifecycleRevision !== entry.lifecycleRevision) ||
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
              throw new DispatchSessionRefreshRequiredError(
                new Error("Session changed while restoring archived work. Retry the request."),
              );
            }
          }
        : undefined;
      if (currentEntry.worktree) {
        const { restoreSessionWorktree } =
          await import("../../sessions/session-worktree-lifecycle.js");
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
