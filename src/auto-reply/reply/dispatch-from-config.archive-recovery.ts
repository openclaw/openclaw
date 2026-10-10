import { isDeepStrictEqual } from "node:util";
import { isRestartRecoveryTombstone } from "../../config/sessions/lifecycle.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import {
  bindPreparedSessionSourceAssertion,
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
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
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import { isNativeCommandTurn } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";

export async function restoreArchivedDispatchSession(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  hasPluginOwnedBinding: boolean;
  allowNativeCommandRestore?: boolean;
  additionalCommitGuard?: SessionSourceAssertion;
  targetMutationScope?: {
    sessionKey: string;
    storePath: string;
    expected?: SessionEntry;
  };
  assertCurrent?: () => void;
  requireSnapshotMatch?: boolean;
  placementContext?: SessionWorkerPlacementContext;
  sessionKey?: string;
  storePath?: string;
}): Promise<SessionEntry | undefined> {
  const { ctx, entry, hasPluginOwnedBinding, sessionKey, storePath } = params;
  params.assertCurrent?.();
  if (
    !entry ||
    !sessionKey ||
    !storePath ||
    entry.archivedAt === undefined ||
    isRestartRecoveryTombstone(entry) ||
    hasPluginOwnedBinding ||
    (params.allowNativeCommandRestore && entry.pluginOwnerId !== undefined) ||
    ctx.InboundAccessAuthorized !== true ||
    ctx.InboundEventKind === "room_event" ||
    (isNativeCommandTurn(ctx.CommandTurn) && !params.allowNativeCommandRestore) ||
    classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType !== "human"
  ) {
    return entry;
  }
  const scope = { sessionKey, storePath };
  const actor = captureIncognitoSessionSource(scope);
  const metadata = actor ? captureSessionEntryMetadataRead(scope) : undefined;
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
      (params.allowNativeCommandRestore && currentEntry.pluginOwnerId !== undefined) ||
      ((actor || params.requireSnapshotMatch) &&
        currentEntry.lifecycleRevision !== entry.lifecycleRevision) ||
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
  return await runExclusiveSessionLifecycleMutation("restore", {
    targets: [
      { scope: storePath, identities: [sessionKey, snapshotSessionId] },
      ...(params.targetMutationScope
        ? [
            {
              scope: params.targetMutationScope.storePath,
              identities: [
                params.targetMutationScope.sessionKey,
                params.targetMutationScope.expected?.sessionId,
              ],
            },
          ]
        : []),
    ],
    run: async () => {
      // The target fence excludes lifecycle replacement while source worktree restoration awaits.
      // A same-store host worker also checks the captured target row at source commit.
      if (params.targetMutationScope) {
        const target = params.targetMutationScope;
        const current = await readSessionEntryReadOnlyInWorker(
          { ...target, readConsistency: "latest", clone: false },
          params.assertCurrent ?? (() => {}),
        );
        if (
          (current === undefined) !== (target.expected === undefined) ||
          (["sessionId", "archivedAt", "pluginOwnerId", "lifecycleRevision"] as const).some(
            (field) => !isDeepStrictEqual(current?.[field], target.expected?.[field]),
          )
        ) {
          throw new DispatchSessionRefreshRequiredError(
            new Error("Command target changed while restoring archived work. Retry the request."),
          );
        }
      }
      const currentEntry = actor
        ? "kind" in actor
          ? undefined
          : (
              await actor.actor.sessions.read(
                { assertCurrent: () => metadata!.assertCurrent() },
                { sessionKey },
                actor.admissionSignal,
              )
            ).entry
        : loadSessionEntryReadOnly(scope);
      params.assertCurrent?.();
      metadata?.assertCurrent();
      if (
        !currentEntry ||
        !canRestore(currentEntry, {
          placement: await readSessionWorkerPlacementAsync({
            context: placementContext,
            sessionId: currentEntry.sessionId,
          }),
        })
      ) {
        if (params.requireSnapshotMatch) {
          throw new DispatchSessionRefreshRequiredError(
            new Error("Session changed while restoring archived work. Retry the request."),
          );
        }
        return currentEntry;
      }
      params.assertCurrent?.();
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
      const retainedTargetGuard =
        currentEntry.worktree && params.additionalCommitGuard
          ? bindPreparedSessionSourceAssertion(
              params.additionalCommitGuard,
              await prepareSessionSourceAuthority(params.additionalCommitGuard),
            )
          : undefined;
      try {
        const assertRestoreCurrent = composeSessionSourceAssertion([
          assertCommitAllowed,
          params.assertCurrent,
          retainedTargetGuard ?? params.additionalCommitGuard,
        ]);
        if (currentEntry.worktree) {
          const { restoreSessionWorktree } =
            await import("../../sessions/session-worktree-lifecycle.js");
          // Keep the target fenced through Git/allocation waits without retaining the agent writer.
          assertCommitAllowed = await restoreSessionWorktree({
            entry: currentEntry,
            scope,
            commitGuard: composeSessionSourceAssertion([
              assertRestoreCurrent,
              await prepareSessionWorkerPlacementMutationCheckAsync({
                context: placementContext,
                sessionId: currentEntry.sessionId,
              }),
            ]),
          });
        }
        assertCommitAllowed = composeSessionSourceAssertion([
          assertCommitAllowed,
          params.assertCurrent,
          retainedTargetGuard ?? params.additionalCommitGuard,
        ]);
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
      } finally {
        await retainedTargetGuard?.release();
      }
    },
  });
}
