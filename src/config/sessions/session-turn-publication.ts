import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import type { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-worker-publication.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type { captureSessionPendingInputWorkerCustody } from "./session-accessor.sqlite-pending-inputs.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { installCommittedTranscriptMessageSequences } from "./session-accessor.sqlite-transcript-sequences.js";
import type { SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import { completeSessionTranscriptCommit } from "./session-transcript-commit-completion.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import type { SessionTurnCommitted, SqliteSessionTurnOptions } from "./session-turn.types.js";

export function publishCommittedSessionTurn(
  candidate: SessionTurnCommitted,
  {
    scope,
    database,
    options,
    custody,
    committedCompletions,
    execution,
    inputActor,
  }: {
    scope: ResolvedTranscriptScope;
    database: OpenClawAgentDatabaseOptions & { path: string };
    options: Pick<SqliteSessionTurnOptions, "onMessageCommitted" | "onCommittedSource">;
    custody: ReturnType<typeof captureSessionPendingInputWorkerCustody>;
    committedCompletions: Promise<void>[];
    execution: Pick<OpenClawAgentDatabaseExecution, "fileIdentity"> | undefined;
    inputActor: { target: SessionEntryTargetPatchScope } | undefined;
  },
): void {
  try {
    if (candidate.custody) {
      custody?.publish(candidate.custody);
    }
    installCommittedTranscriptMessageSequences(
      candidate.result.appendedMessages,
      candidate.sequences,
    );
    // Accept canonical custody before source/identity publication can fail.
    try {
      const completion = completeSessionTranscriptCommit(
        candidate.result.appendedMessages,
        options.onMessageCommitted,
        candidate.result,
      );
      if (completion) {
        void completion.catch(() => undefined);
        committedCompletions.push(completion);
      }
    } catch (error) {
      const completion = Promise.reject(
        toErrorObject(error, "Session transcript completion failed"),
      );
      void completion.catch(() => undefined);
      committedCompletions.push(completion);
    }
    if (
      options.onCommittedSource &&
      !candidate.result.rejectedReason &&
      candidate.result.sessionEntry
    ) {
      const identity = execution?.fileIdentity;
      const originalSource = inputActor?.target.readSource;
      if (!identity && !originalSource) {
        throw new Error("Committed transcript turn omitted its admitted database identity");
      }
      options.onCommittedSource(
        originalSource ?? {
          agentId: scope.agentId,
          path: database.path,
          databaseIdentity: identity!.physicalIdentity,
          databaseBirthtime: identity?.birthtime,
        },
        candidate.result.sessionEntry,
      );
    }
  } finally {
    if (candidate.projectionNeedsReconcile) {
      startSessionTranscriptIndexReconcile({
        ...database,
        preferredSessionId: scope.sessionId,
      });
    }
  }
}

export function completeSessionTurnPublication(
  candidate: SessionTurnCommitted,
  agentId: string,
  identity: string,
  published: ReturnType<ReturnType<typeof retainSessionEntryWorkerPublication>["settle"]>,
): SessionTurnCommitted["result"] {
  if (published) {
    publishCommittedSessionIdentity(
      agentId,
      identity,
      published.previous,
      published.current,
      published.prepared,
    );
  }
  return candidate.result;
}
