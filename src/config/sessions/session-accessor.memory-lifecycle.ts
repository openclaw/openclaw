import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { MODEL_SELECTION_LOCK_REMOVAL_MESSAGE } from "../../sessions/agent-harness-session-key.js";
import { assertModelSelectionUnlocked } from "../../sessions/model-overrides.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
} from "./session-accessor.sqlite-contract.js";
import { withSqliteSessionDeletions } from "./session-accessor.sqlite-deletion.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { captureSessionTranscriptTargetBinding } from "./transcript-target-binding.js";

export function resetMemorySessionEntryLifecycle(
  params: ResetSessionEntryLifecycleParams,
): Promise<ResetSessionEntryLifecycleResult> | undefined {
  const scope = { ...params, sessionKey: params.target.canonicalKey };
  const assertCurrent = () => params.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  if (!captureSessionActorStorageOwner(scope, authority)) {
    return undefined;
  }
  return withSessionActorStorage(
    scope,
    {
      authority,
      lifetime: { assertCurrent, assertReadable: assertCurrent },
      // The reset API also creates its replacement when the prior entry is absent.
      create: true,
    },
    async (memory) => {
      const owner = captureSessionActorStorageOwner({ sessionActor: memory })!.owner!;
      const expected = await memory.actor.storage.read(
        { type: "session.entry.read", input: {} },
        memory.authority,
      );
      const nextEntry = await params.buildNextEntry({
        currentEntry: expected && structuredClone(expected),
        primaryKey: scope.sessionKey,
      });
      const { progressCardReset: _progressCardReset, ...mutation } = readSessionActorStorageResult(
        await memory.actor.storage.mutate(
          {
            type: "session.lifecycle.reset",
            input: {
              expected,
              nextEntry: structuredClone(nextEntry),
              resetBoundary: params.resetBoundary,
            },
          },
          memory.authority,
        ),
      );
      const target = captureSessionTranscriptTargetBinding({
        agentId: memory.agentId,
        storePath: memory.path,
      });
      await params.afterEntryMutation?.(mutation, {
        env: Object.freeze(target.env),
        source: { agentId: memory.agentId, path: memory.path },
        assertCurrent: () => owner.assertCurrent(),
      });
      return mutation;
    },
  ).then((result) => {
    if (!result) {
      throw new Error("Memory session reset lost its selected owner");
    }
    return result;
  });
}

export function deleteMemorySessionEntryLifecycle(
  params: DeleteSessionEntryLifecycleParams,
  allowLocked = false,
): Promise<DeleteSessionEntryLifecycleResult> | undefined {
  const scope = {
    ...params,
    sessionKey: params.target.canonicalKey,
  };
  const assertCurrent = () => params.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  const captured = captureSessionActorStorageOwner(scope, authority);
  if (!captured) {
    return undefined;
  }
  const absent: DeleteSessionEntryLifecycleResult = {
    deleted: false,
    archivedTranscripts: [],
    ...(params.expectedEntry ||
    params.expectedSessionId != null ||
    params.expectedLifecycleRevision !== undefined ||
    params.expectedUpdatedAt !== undefined
      ? { expectedEntryMismatch: true as const }
      : {}),
  };
  return withSessionActorStorage(
    scope,
    {
      authority,
      lifetime: { assertCurrent, assertReadable: assertCurrent },
    },
    async (memory) => {
      const entry = await memory.actor.storage.read(
        { type: "session.entry.read", input: {} },
        memory.authority,
      );
      if (!entry) {
        return absent;
      }
      const owner = captured.owner!;
      const target = captureSessionTranscriptTargetBinding({
        agentId: memory.agentId,
        storePath: memory.path,
        env: params.env,
      });
      return withSqliteSessionDeletions(
        {
          agentId: memory.agentId,
          path: memory.path,
          env: target.env,
          ownerStorePath: params.storePath,
        },
        [{ sessionKey: scope.sessionKey, entry }],
        async (assertDeletionCurrent, capture, settleReceipts) => {
          let authorityError: unknown;
          const companions: { settlement?: ReturnType<typeof capture> } = {};
          const outcome = await memory.actor.storage.mutate(
            {
              type: "session.lifecycle.delete",
              input: {
                expectedEntry: params.expectedEntry,
                expectedSessionId:
                  params.expectedSessionId === undefined
                    ? entry.sessionId
                    : params.expectedSessionId,
                expectedLifecycleRevision:
                  params.expectedLifecycleRevision ?? entry.lifecycleRevision,
                expectedUpdatedAt: params.expectedUpdatedAt,
              },
            },
            {
              assertCurrent() {
                try {
                  memory.authority.assertCurrent();
                  assertDeletionCurrent();
                } catch (error) {
                  authorityError = error;
                  throw error;
                }
              },
              authorize(stage, facts, publication) {
                memory.authority.authorize(stage, facts, publication);
                if (!allowLocked && facts.entry) {
                  assertModelSelectionUnlocked(facts.entry, MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
                }
              },
            },
            {
              beforeCommit(receipt) {
                if (receipt.value.deleted && receipt.value.deletedEntry) {
                  companions.settlement = capture([
                    { sessionKey: scope.sessionKey, entry: receipt.value.deletedEntry },
                  ]);
                  companions.settlement.beforeCommit();
                }
              },
            },
          );
          companions.settlement?.settle(outcome.kind);
          if (outcome.kind === "rolled-back") {
            if (authorityError) {
              throw toErrorObject(
                authorityError,
                "Session deletion authority rejected the operation",
              );
            }
          } else if (outcome.value.deleted) {
            await settleReceipts(() => owner.assertCurrent());
          }
          return readSessionActorStorageResult(outcome);
        },
        {
          memory: owner,
          receiptsOnCommit: {
            generations: [
              {
                agentId: memory.agentId,
                sessionKey: scope.sessionKey,
                sessionId: entry.sessionId,
                lifecycleRevision: entry.lifecycleRevision ?? null,
              },
            ],
          },
        },
      );
    },
  ).then((result) => result ?? absent);
}
