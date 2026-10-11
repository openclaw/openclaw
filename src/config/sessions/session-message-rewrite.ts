import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import type { SessionTranscriptWriteScope } from "./session-accessor.sqlite-contract.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import {
  rewriteAssistantTranscriptMessageForRun,
  rewriteTranscriptMessageAtAnchor,
} from "./session-accessor.sqlite-transcript-message-rewrite.js";
import type { SessionTranscriptAccessScope } from "./session-accessor.types.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type { SessionEntryReadSource } from "./session-entry-read-source.types.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type {
  SessionMessageRewriteCommitted,
  SessionMessageRewriteSelection,
} from "./session-transcript-mutation.types.js";
import type { SessionLifecycleRevisionExpectation } from "./session-transcript-turn-lifecycle.types.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  assertOwnedTranscriptWriteCommit,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Bundled pure preparation; opaque public callbacks retain their transaction-local adapter. */
async function rewritePreparedTranscriptMessage<T>(params: {
  scope: SessionTranscriptWriteScope;
  readSource?: SessionEntryReadSource;
  target: SessionMessageRewriteSelection["target"];
  expectedEntry?: SessionMessageRewriteSelection["expectedEntry"];
  prepare(message: unknown): T | undefined;
  assertCurrent?: () => void;
}): Promise<{ generation: string; messageId: string; message: T } | null> {
  const requested = params.readSource
    ? { ...params.scope, agentId: params.readSource.agentId, storePath: params.readSource.path }
    : params.scope;
  const assertCurrent = () => params.assertCurrent?.();
  const authority = { assertCurrent, authorize: assertCurrent };
  if (captureSessionActorStorageOwner(requested, authority)) {
    const captured = await withSessionActorStorage(
      requested,
      { authority, lifetime: { assertCurrent, assertReadable: assertCurrent } },
      async (memory) => {
        const scope = {
          ...requested,
          agentId: memory.agentId,
          storePath: memory.path,
          sessionId:
            requested.sessionId ?? memory.actor.snapshot(memory.authority)?.entry?.sessionId,
        };
        if (!scope.sessionId) {
          return { result: null };
        }
        const input = {
          scope: { ...scope, sessionId: scope.sessionId },
          target: params.target,
          expectedEntry: params.expectedEntry,
        };
        const expected = await memory.actor.storage.read(
          { type: "session.rewrite.prepare", input },
          memory.authority,
        );
        assertCurrent();
        if (!expected) {
          return { result: null };
        }
        const message = params.prepare(expected.event.message);
        const committed = readSessionActorStorageResult(
          await memory.actor.storage.mutate(
            { type: "session.rewrite.commit", input: { ...input, expected, message } },
            memory.authority,
          ),
        );
        // SAFETY: This invocation's typed preparer is the only source of the replacement message.
        return {
          result: committed.result as { generation: string; messageId: string; message: T } | null,
        };
      },
    );
    if (!captured) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return captured.result;
  }
  const scope = captureLifecycleDatabaseScope(
    resolveSqliteTranscriptScope(requested, params.readSource),
  );
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const selection = structuredClone({
    scope,
    target: params.target,
    expectedEntry: params.expectedEntry,
  });
  return await runSessionEntryWorkerOperation<
    SessionMessageRewriteCommitted,
    { generation: string; messageId: string; message: T } | null
  >({
    database,
    agentId: scope.agentId,
    candidateKind: "session-message-rewrite",
    assertCurrent: () => params.assertCurrent?.(),
    prepareWorker:
      selection.target.kind === "terminal-assistant"
        ? () => ({
            async prepare() {
              const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
              await restoreSessionColdTranscript({
                ...scope,
                storePath: scope.path,
              });
            },
            beforeWrite() {},
            async release() {},
          })
        : undefined,
    async run(worker, commit) {
      const expected = await executeSessionMessageRewriteOperation(worker, database.agentId, {
        type: "session.messageRewrite.prepare",
        input: selection,
      });
      params.assertCurrent?.();
      if (!expected) {
        return null;
      }
      const message = params.prepare(expected.event.message);
      params.assertCurrent?.();
      return commit(() =>
        executeSessionMessageRewriteOperation(worker, database.agentId, {
          type: "session.messageRewrite.commit",
          input: { ...selection, expected, message },
        }),
      );
    },
    onCommitted: ({ result }) => {
      // SAFETY: This command returns the message produced by this invocation's typed preparer.
      return result as { generation: string; messageId: string; message: T } | null;
    },
  });
}

export async function rewritePreparedTranscriptMessageAtAnchor<T>(
  anchor: TranscriptEntryAnchor,
  prepare: (message: unknown) => T | undefined,
  options: Pick<
    Parameters<typeof rewritePreparedTranscriptMessage<T>>[0],
    "assertCurrent" | "expectedEntry"
  > & { active?: "exact" | "sequence"; assertNativeCurrent?: () => void } = {},
) {
  if (!isMainThread) {
    return rewriteTranscriptMessageAtAnchor(anchor, (message) => {
      options.assertCurrent?.();
      options.assertNativeCurrent?.();
      if (options.active) {
        const active = readActiveTranscriptEntryAnchor(anchor);
        if (
          options.active === "exact"
            ? !isDeepStrictEqual(active, anchor)
            : active?.rawSeq !== anchor.rawSeq
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
      }
      return prepare(message);
    });
  }
  return rewritePreparedTranscriptMessage({
    ...options,
    scope: anchor,
    target: { kind: "anchor", anchor, active: options.active },
    prepare,
  });
}

export async function rewritePreparedAssistantTranscriptMessageForRun(params: {
  scope: SessionTranscriptAccessScope & SessionTranscriptWriteScope;
  readSource?: SessionEntryReadSource;
  runId: string;
  expectedLifecycleRevision: SessionLifecycleRevisionExpectation;
  rewriteMessage(message: Record<string, unknown>): Record<string, unknown>;
}): Promise<{ messageId: string } | null> {
  if (!isMainThread) {
    const resolved = resolveSqliteTranscriptScope(params.scope, params.readSource);
    return rewriteAssistantTranscriptMessageForRun(
      params,
      params.readSource ? resolved : undefined,
    );
  }
  const scope = withOwnedSessionTranscriptWriterFence({
    ...params.scope,
    expectedLifecycleRevision: params.expectedLifecycleRevision ?? undefined,
  });
  if (
    scope.expectedLifecycleRevision !== undefined &&
    scope.expectedLifecycleRevision !== (params.expectedLifecycleRevision ?? undefined)
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const result = await rewritePreparedTranscriptMessage({
    scope: params.scope,
    readSource: params.readSource,
    target: { kind: "terminal-assistant", runId: params.runId },
    expectedEntry: {
      lifecycleRevision: params.expectedLifecycleRevision ?? null,
      activeWriterRunId: scope.expectedWriterRunId,
      owner: scope.expectedOwner,
    },
    assertCurrent: () => assertOwnedTranscriptWriteCommit(scope),
    prepare: (message) => {
      // SAFETY: The terminal-assistant worker selector admits only record messages.
      const rewritten = params.rewriteMessage(message as Record<string, unknown>);
      return isDeepStrictEqual(message, rewritten) ? undefined : rewritten;
    },
  });
  return result ? { messageId: result.messageId } : null;
}
