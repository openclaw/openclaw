import type { SessionTranscriptInitializationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntryReplacementCommit } from "../config/sessions/session-accessor.sqlite-replacement-types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers, WorkerOperations } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;
type TranscriptInitialization = { sessionKey: string; sessionId: string; cwd?: string };

let transcript:
  | {
      initialize: typeof import("../config/sessions/session-accessor.sqlite-transcript-header.js").ensureTranscriptHeader;
      assertIdentity: typeof import("../config/sessions/session-accessor.sqlite-scope.js").assertSqliteTranscriptWriteIdentity;
    }
  | undefined;

export function prepareAgentTranscript() {
  return Promise.all([
    import("../config/sessions/session-accessor.sqlite-transcript-header.js"),
    import("../config/sessions/session-accessor.sqlite-scope.js"),
  ]).then(([header, scope]) => {
    transcript = {
      initialize: header.ensureTranscriptHeader,
      assertIdentity: scope.assertSqliteTranscriptWriteIdentity,
    };
  });
}

export async function loadAgentTranscriptOperations() {
  await prepareAgentTranscript();
  return {
    "session.transcript.initialize": (input: TranscriptInitialization, context) => {
      if (!transcript) {
        throw new Error("Session transcript initialization was not prepared");
      }
      const { initialize } = transcript;
      const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
      assertIdentity(input);
      return context.writeTransaction(
        "session.entry.create-with-transcript",
        "Session transcript",
        (current) => {
          const publication: SessionTranscriptInitializationPublication = {
            kind: "session-transcript-initialized",
            sessionKey: input.sessionKey,
          };
          initialize(
            current,
            { agentId: context.options.agentId, path: context.options.path, ...input },
            input.cwd,
            {
              onPlaceholderInserted: ({ sessionId }) => {
                publication.placeholder = { sessionId };
              },
            },
          );
          deferSqliteWorkerCommitReceipt(current.db, publication);
          context.admit("commit", publication);
          return publication;
        },
      );
    },
  } satisfies Handlers;
}

export async function loadAgentReplacementOperations() {
  const kernel = await import("../config/sessions/session-accessor.sqlite-replacement-state.js");
  return {
    "session.entries.replace": (
      input: SessionEntryReplacementCommit & { initializeTranscript?: TranscriptInitialization },
      context,
    ) =>
      context.writeTransaction("session.entry-replacements", "Session replacement", (current) => {
        const result = kernel.commitSessionEntryReplacementsInDatabase(current, input, () => {
          const initialization = input.initializeTranscript;
          if (!initialization) {
            return;
          }
          try {
            if (!transcript) {
              throw new Error("Session transcript initialization was not prepared");
            }
            const { initialize } = transcript;
            const assertIdentity: typeof transcript.assertIdentity = transcript.assertIdentity;
            assertIdentity(initialization);
            initialize(
              current,
              { agentId: context.options.agentId, path: context.options.path, ...initialization },
              initialization.cwd,
            );
          } catch (error) {
            throw Object.assign(new Error(formatErrorMessage(error), { cause: error }), {
              name: "SessionTranscriptInitializationError",
            });
          }
        });
        const publication = kernel.prepareSessionEntryReplacementPublication(result);
        deferSqliteWorkerCommitReceipt(current.db, publication);
        context.admit("commit", publication);
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentRestartRecoveryOperations() {
  const kernel = await import("../config/sessions/session-accessor.sqlite-recovery.worker.js");
  return {
    "session.restart.recover": (
      input: Parameters<typeof kernel.recoverRestartTombstoneInDatabase>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.lifecycle.recover-tombstone", "Session recovery", (current) => {
        const result = kernel.recoverRestartTombstoneInDatabase(current, input);
        deferSqliteWorkerCommitReceipt(
          current.db,
          result.publication ?? { kind: "session-restart-recovery-unchanged" },
        );
        admit("commit", result.publication);
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentEntryReadOperations() {
  const kernel = await import("../config/sessions/session-accessor.sqlite-entry-read.js");
  return {
    "session.entry.read": (input: { sessionKey: string }, { open }) =>
      kernel.readSessionEntryRow(open(), input.sessionKey)?.entry,
  } satisfies Handlers;
}

export async function loadAgentTrajectoryOperations() {
  const kernel = await import("../trajectory/runtime-store.sqlite.js");
  return {
    "trajectory.events.append": (
      input: Parameters<typeof kernel.appendSqliteTrajectoryRuntimeEventsInTransaction>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("trajectory.runtime.append", "Trajectory append", (current) => {
        kernel.appendSqliteTrajectoryRuntimeEventsInTransaction(current, input);
        deferSqliteWorkerCommitReceipt(current.db, { kind: "trajectory-runtime-append" });
        admit("commit");
      }),
  } satisfies Handlers;
}

export async function loadAgentArchiveOperations() {
  const kernel = await import("../config/sessions/session-accessor.sqlite-archive-store-kernel.js");
  return {
    "session.archives.preparePublication": (
      input: Parameters<typeof kernel.prepareSessionTranscriptArchivePublishPlans>[1],
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.archive.publish", "Session archive publication", (current) => {
        const result = kernel.prepareSessionTranscriptArchivePublishPlans(current, input);
        admit("commit");
        return result;
      }),
    "session.archives.recordPublication": (
      input: {
        results: Parameters<typeof kernel.recordSessionTranscriptArchivePublishResults>[1];
        nowMs: number;
      },
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.archive.publish", "Session archive publication", (current) => {
        const result = kernel.recordSessionTranscriptArchivePublishResults(
          current,
          input.results,
          input.nowMs,
        );
        admit("commit");
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentAcpOperations() {
  const kernel = await import("../acp/runtime/session-meta-entry.worker.js");
  return {
    "session.entry.acp": (
      input: Parameters<typeof kernel.mutateAcpSessionEntryInWorker>[2],
      { open, options, admit },
    ) => kernel.mutateAcpSessionEntryInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

export async function loadAgentProviderReviewOperations() {
  const kernel = await import("../config/sessions/provider-review-store.worker.js");
  return {
    "session.providerReview.compare": (
      input: Parameters<typeof kernel.compareSessionProviderReviewInWorker>[2],
      { open, options, admit },
    ) => kernel.compareSessionProviderReviewInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

export async function loadAgentReactionOperations() {
  const kernel = await import("../config/sessions/session-reaction-store.kernel.js");
  return {
    "session.reaction.set": (
      input: {
        sessionKey: string;
        params: Parameters<typeof kernel.setSessionReactionInDatabase>[2];
      },
      { writeTransaction, admit },
    ) =>
      writeTransaction("session.reaction.set", "Reaction write", (current) => {
        const result = kernel.setSessionReactionInDatabase(current, input.sessionKey, input.params);
        admit("commit");
        return result;
      }),
  } satisfies Handlers;
}

export async function loadAgentPendingInputOperations() {
  const kernel = await import("../config/sessions/session-pending-input-withdrawal.worker.js");
  return {
    "session.pendingInputs.withdraw": (
      input: Parameters<typeof kernel.discardSessionPendingInputInWorker>[2],
      { open, options, admit },
    ) => kernel.discardSessionPendingInputInWorker(open(), options, input, admit),
  } satisfies Handlers;
}

export async function loadAgentArchivePruningOperations() {
  const kernel = await import("../config/sessions/session-history-archive-pruning.worker.js");
  return {
    "session.archivePruning.deletePublished": (
      input: Parameters<typeof kernel.deletePublishedSessionArchiveInDatabase>[2],
      { open, options, admit },
    ) => kernel.deletePublishedSessionArchiveInDatabase(open(), options, input, admit),
    "session.archivePruning.removeLegacy": (
      input: { filePath: string },
      { open, options, admit },
    ) => kernel.removeLegacySessionArchiveInDatabase(open(), options, input.filePath, admit),
    "session.archivePruning.reclaimPages": (input: { maxPages?: number }, { open, admit }) =>
      kernel.reclaimSessionArchivePagesInWorker(open(), input.maxPages, admit),
  } satisfies Handlers;
}

export type RegisteredAgentWorkerOperations = WorkerOperations<
  Awaited<ReturnType<typeof loadAgentTranscriptOperations>> &
    Awaited<ReturnType<typeof loadAgentReplacementOperations>> &
    Awaited<ReturnType<typeof loadAgentEntryReadOperations>> &
    Awaited<ReturnType<typeof loadAgentRestartRecoveryOperations>> &
    Awaited<ReturnType<typeof loadAgentTrajectoryOperations>> &
    Awaited<ReturnType<typeof loadAgentArchiveOperations>> &
    Awaited<ReturnType<typeof loadAgentAcpOperations>> &
    Awaited<ReturnType<typeof loadAgentProviderReviewOperations>> &
    Awaited<ReturnType<typeof loadAgentReactionOperations>> &
    Awaited<ReturnType<typeof loadAgentPendingInputOperations>> &
    Awaited<ReturnType<typeof loadAgentArchivePruningOperations>>
>;
