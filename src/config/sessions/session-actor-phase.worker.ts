import { sqlPublicationAnchor } from "../../infra/sql-connection.js";
import { retainSqliteDatabaseWriteScopesForPath } from "../../infra/sqlite-database-admission.js";
import { withSqlitePreparedNativeMutation } from "../../infra/sqlite-native-observer.js";
import {
  prepareSqliteTransactionCommit,
  stageSqliteTransactionState,
  withSqlitePostCommitPublications,
} from "../../infra/sqlite-post-commit.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  deferCapturedSqliteWorkerCommitReceipt,
  deferSqliteWorkerCommitReceipt,
} from "../../infra/sqlite-worker-operation-admission.js";
import { captureSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-settlement.js";
import { createSqliteWorkerTransferOwner } from "../../infra/sqlite-worker-transfer.js";
import {
  captureSessionRowChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  prepareSessionActorEntryWrite,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-write.js";
import { applySessionActorAppend } from "./session-actor-append.worker.js";
import type { projectSessionActorAuthority } from "./session-actor-command.js";
import type {
  SessionActorOutcome,
  SessionActorPhaseResults,
  SessionActorPhase,
} from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  applySessionActorPhaseWithBackend,
  type SessionActorMutation,
} from "./session-actor-phase.js";
import {
  forkSessionActorStoredState,
  withSessionActorTransactionState,
} from "./session-actor-transaction.js";
import { readHarnessCompletionSourceInDatabase } from "./session-harness-completion-source.kernel.js";
import { applySessionTranscriptEvent } from "./session-message-rewrite.worker.js";
import { mutatePendingInput } from "./session-pending-input-operations.kernel.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { applySessionTurn } from "./session-turn.worker.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export { SessionActorStaleStateError } from "./session-actor-phase.js";

/** The actor lends one transaction; nested kernels retain admission without opening savepoints. */
export function applySessionActorPhase(
  command: SessionActorMutation,
  state: SessionActorStoredState,
  context: AgentWorkerOperationContext,
  prepareEntry?: (next: SessionEntry) => void,
) {
  const database = context.open();
  const hot = state.hot;
  const sessionKey = hot.target.sessionKey;
  const incarnation =
    hot.target.database.kind !== "file" ? hot.target.database.incarnation : undefined;
  return applySessionActorPhaseWithBackend(command, hot, {
    agentId: database.agentId,
    writeEntry(next) {
      if (prepareEntry) {
        prepareEntry(next);
        return;
      }
      const previous = hot.entry;
      if (!previous) {
        throw new Error("Session actor requires an existing session");
      }
      writeSessionEntry(database, sessionKey, next, {
        canonicalPreviousEntry: previous,
        previousEntry: previous,
      });
    },
    turn: (input) =>
      applySessionTurn(input, context, (_database, candidate) => candidate, incarnation),
    append(input) {
      const result = applySessionActorAppend(input, state, context);
      // Initialization may rehydrate storage; keep the phase's shared hot object current.
      if (state.hot !== hot) {
        Object.assign(hot, state.hot);
        state.hot = hot;
      }
      return result;
    },
    appendEvent(input) {
      const scope = {
        agentId: database.agentId,
        path: database.path,
        sessionKey,
        sessionId: input.sessionId,
      };
      return applySessionTranscriptEvent(
        {
          scope,
          eventJson: input.eventJson,
          fence: {
            ...scope,
            expectedLifecycleRevision: input.lifecycleRevision ?? undefined,
            expectedWriterRunId: input.writerRunId,
          },
        },
        context,
        (_database, candidate) => candidate,
      );
    },
    validateSources: (sources) => readSessionSourceValidation(database, sources, incarnation),
    validateRecoveryInput: (claim) =>
      readHarnessCompletionSourceInDatabase(database, claim).validInput,
    mutatePendingInput: (input) => mutatePendingInput(input, context, () => {}),
    admit: (stage, publication) => context.admit(stage, publication),
  });
}

/** Prepare a resident no-turn phase once, then use its entry owner's effect certificate. */
export function applyPreparedSessionActorAdoption({
  database,
  before,
  working,
  command,
  context,
  writeScopes,
  recordApplied,
  finish,
}: {
  database: OpenClawAgentDatabase;
  before: SessionActorStoredState;
  working: SessionActorStoredState;
  command: SessionActorMutation;
  context: AgentWorkerOperationContext;
  writeScopes: Parameters<typeof retainSqliteDatabaseWriteScopesForPath>[1];
  recordApplied: () => void;
  finish: (
    state: SessionActorStoredState,
    changes: {
      result: ReturnType<typeof applySessionActorPhase>;
      changes: readonly SessionRowChange[];
    },
    requiresTransaction?: Error,
  ) => { kind: "committed" };
}): { kind: "committed" } {
  const requiresTransaction = new Error("Actor receipt requires transaction");
  // This branch only borrows already resident facts for no-turn adoption.
  // The phase/reducers run once; entry ownership decides whether their effect is atomic.
  let next: SessionEntry | undefined;
  const applied = applySessionActorPhase(command, working, context, (entry) => {
    next = entry;
  });
  recordApplied();
  const prepared = next
    ? prepareSessionActorEntryWrite(database, working, next)
    : { kind: "unchanged" as const };
  if (prepared.kind === "single-node") {
    let result: { kind: "committed" } | undefined;
    try {
      withSqlitePostCommitPublications(database.db, () =>
        withSqlitePreparedNativeMutation(
          prepared.database,
          () => {
            const release = retainSqliteDatabaseWriteScopesForPath(database.path, writeScopes);
            if (release) {
              stageSqliteTransactionState(database.db, {
                commit: release,
                rollback: release,
                invalidate: release,
              });
            }
            const changes = captureSessionRowChanges(database.db, () => {
              prepared.publish();
              return applied;
            });
            result = finish(working, changes, requiresTransaction);
            prepareSqliteTransactionCommit(database.db);
          },
          () => prepared.write(),
        ),
      );
      return result!;
    } catch (error) {
      if (error !== requiresTransaction) {
        throw error;
      }
    }
  }
  // A rejected size selection has discarded its staged facts. Preserve the
  // phase result but recreate its private state under ordinary rollback custody.
  const fallback = forkSessionActorStoredState(before);
  return runSqliteImmediateTransactionSync(database.db, () =>
    withSessionActorTransactionState(database, fallback, () =>
      finish(
        fallback,
        captureSessionRowChanges(database.db, () => {
          if (next) {
            writeSessionEntry(database, before.hot.target.sessionKey, next, {
              canonicalPreviousEntry: before.hot.entry,
              previousEntry: before.hot.entry,
            });
          }
          return applied;
        }),
      ),
    ),
  );
}

/** Capture the outcome once and stage its existing inline or transfer publication. */
export function deferSessionActorOutcome({
  database,
  outcome,
  state,
  projectAuthority,
  publication,
  admit,
  diagnosticContext,
  recordReceipt,
  requiresTransaction,
}: {
  database: OpenClawAgentDatabase;
  outcome: Extract<
    SessionActorOutcome<SessionActorPhaseResults[SessionActorPhase]>,
    { kind: "committed" }
  >;
  state: SessionActorStoredState;
  projectAuthority: typeof projectSessionActorAuthority;
  publication: unknown;
  admit: AgentWorkerOperationContext["admit"];
  diagnosticContext: Record<string, number | boolean | undefined>;
  recordReceipt: () => void;
  requiresTransaction?: Error;
}): void {
  const captured = captureSqliteWorkerCommitReceipt(outcome);
  diagnosticContext.actorReceiptBytes =
    captured.kind === "inline" ? captured.payloadBytes : captured.serialized.byteLength;
  if (captured.kind === "oversized") {
    if (requiresTransaction) {
      throw requiresTransaction;
    }
    const transfer = createSqliteWorkerTransferOwner();
    const handle = transfer.start([{ kind: "outcome", serialized: captured.serialized }].values(), {
      kinds: ["outcome"],
    });
    try {
      let frame = transfer.next(handle.id);
      let finalFrames;
      for (;;) {
        const next = transfer.next(handle.id);
        if (next.done) {
          finalFrames = [frame, next];
          break;
        }
        admit("transaction", {
          kind: "session-actor-admission",
          snapshot: projectAuthority(state.hot),
          publication: {
            kind: "session-actor-outcome",
            transfer: { handle, frames: [frame] },
          },
        });
        frame = next;
      }
      const receipt = {
        kind: "session-actor-committed-transfer" as const,
        transferId: handle.id,
      };
      deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(database.db), receipt);
      recordReceipt();
      admit("commit", {
        kind: "session-actor-admission",
        snapshot: projectAuthority(state.hot),
        publication: {
          kind: "session-actor-outcome",
          transfer: { handle, frames: finalFrames },
          publication,
        },
        conversationPublication: outcome.receipt.conversationPublication,
        final: true,
      });
      return;
    } finally {
      transfer.cancel();
    }
  }
  deferCapturedSqliteWorkerCommitReceipt(sqlPublicationAnchor(database.db), captured);
  recordReceipt();
  admit("commit", {
    kind: "session-actor-admission",
    snapshot: projectAuthority(state.hot),
    publication,
    conversationPublication: outcome.receipt.conversationPublication,
    final: true,
  });
}
