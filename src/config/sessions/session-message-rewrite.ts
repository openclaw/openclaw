import { isDeepStrictEqual } from "node:util";
import { isMainThread } from "node:worker_threads";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.sqlite-contract.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchor } from "./session-accessor.sqlite-transcript-anchor.js";
import {
  rewriteAssistantTranscriptMessageForRun,
  rewriteTranscriptMessageAtAnchor,
} from "./session-accessor.sqlite-transcript-message-rewrite.js";
import type { SessionTranscriptAccessScope } from "./session-accessor.types.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type { SessionEntryReadSource } from "./session-entry-read-source.types.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
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
  scope: ResolvedTranscriptScope;
  target: SessionMessageRewriteSelection["target"];
  expectedEntry?: SessionMessageRewriteSelection["expectedEntry"];
  prepare(message: unknown): T | undefined;
  assertCurrent?: () => void;
}): Promise<{ generation: string; messageId: string; message: T } | null> {
  const scope = captureLifecycleDatabaseScope(params.scope);
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const selection = structuredClone({
    scope,
    target: params.target,
    expectedEntry: params.expectedEntry,
  });
  const incognito = captureIncognitoSessionOperation({ ...scope, storePath: scope.path });
  if (incognito) {
    const { actor } = incognito;
    const authority = {
      assertCurrent() {
        incognito.authority.assertCurrent();
        params.assertCurrent?.();
      },
    };
    const input = {
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      fence: {},
      target: selection.target,
      expectedEntry: selection.expectedEntry,
    };
    return actor.sessions.withSharedState(async () => {
      const expected = await actor.sessions.transcript(
        authority,
        {
          type: "session.rewrite.prepare",
          input,
        },
        incognito.admissionSignal,
      );
      authority.assertCurrent();
      if (!expected) {
        return null;
      }
      const message = params.prepare(expected.event.message);
      authority.assertCurrent();
      incognito.admissionSignal?.throwIfAborted();
      const { result } = await actor.sessions.transcript(authority, {
        type: "session.rewrite.commit",
        input: { ...input, expected, message },
      });
      // SAFETY: This invocation's typed preparer is the only source of the replacement message.
      return result as { generation: string; messageId: string; message: T } | null;
    });
  }
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
  const scope = resolveSqliteTranscriptScope(anchor);
  if (
    !isMainThread ||
    (!captureIncognitoSessionOperation(anchor) &&
      !supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(scope)))
  ) {
    // Process-held incognito and native maintenance retain their current transaction owner.
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
    scope,
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
  const resolved = resolveSqliteTranscriptScope(params.scope, params.readSource);
  if (
    !isMainThread ||
    (!captureIncognitoSessionOperation(params.scope) &&
      !supportsOpenClawAgentDatabaseExecution(toDatabaseOptions(resolved)))
  ) {
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
    scope: resolved,
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
