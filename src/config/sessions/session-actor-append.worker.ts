import { serialize } from "node:v8";
import {
  decodeMetadataAppendEvent,
  sessionMetadataAppendNeedsReload,
} from "../../agents/sessions/session-manager-append-codec.js";
import {
  applySessionDirectMessageInTransaction,
  applySessionMetadataAppendInTransaction,
} from "../../agents/sessions/session-manager-append.kernel.js";
import {
  runWithMetadataMessageAdmission,
  type MetadataWorkerAdmission,
} from "../../agents/sessions/session-manager-message-admission.worker.js";
import { readSessionManagerReload } from "../../agents/sessions/session-manager-reload.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { runWithCliHistoryWriter } from "./cli-history-boundary.js";
import { ensureSessionEntryInTransaction } from "./session-accessor.sqlite-initial-entry.js";
import { readSessionPendingInputWorkerReceipt } from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionActorAppend, SessionActorAppendCommitted } from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { hydrateSessionActorState } from "./session-actor-hydration.worker.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type {
  InitialSessionEntryCommit,
  SessionMetadataOperations,
} from "./session-manager-write-contract.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";

/** Prepared SessionManager appends share the actor's transaction and its live admission. */
export function applySessionActorAppend(
  append: SessionActorAppend,
  state: SessionActorStoredState,
  context: AgentWorkerOperationContext,
): SessionActorAppendCommitted {
  const database = context.open();
  if (!database.db.isTransaction) {
    throw new Error("Session actor append requires its owning transaction");
  }
  const bindScope = (scope: SessionActorAppend["input"]["scope"]) => {
    const resolved = resolveSqliteTranscriptScope({ ...scope, env: context.options.env });
    const requestedPath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved));
    const sameDatabase =
      state.hot.target.database.kind === "file"
        ? readDatabasePathIdentitySync(requestedPath).canonicalPath === database.path
        : requestedPath === database.path;
    if (
      resolved.agentId !== database.agentId ||
      resolved.sessionKey !== state.hot.target.sessionKey ||
      !sameDatabase
    ) {
      throw new Error("Session actor append changed its captured target");
    }
    assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
    return { ...scope, storePath: database.path, env: context.options.env };
  };
  const admit: MetadataWorkerAdmission = (stage, restriction) => {
    if (!restriction) {
      return context.admit(stage);
    }
    let granted = false;
    restriction({ stage, facts: undefined }, (request) => {
      if (granted || request.stage !== stage) {
        throw new Error("Session metadata changed its native admission stage");
      }
      context.admit(stage, request.facts);
      granted = true;
    });
    if (!granted) {
      throw new Error("Session metadata omitted its admission evidence");
    }
  };
  const messageContext = {
    database: database.db,
    databasePath: database.path,
    admit,
    checkMessage: (facts: unknown) => context.admit("transaction", facts),
  };
  let initialEntry: InitialSessionEntryCommit | undefined;
  if (append.initialization) {
    const input = append.initialization;
    const scope = bindScope(input.scope);
    if (
      input.entry.sessionId !== scope.sessionId ||
      scope.sessionId !== append.input.scope.sessionId
    ) {
      throw new Error("Session actor initializer changed its transcript target");
    }
    context.admit("transaction");
    const absent = state.hot.entry === undefined;
    const heldTranscript = state.window?.session_id === input.entry.sessionId;
    initialEntry = ensureSessionEntryInTransaction(
      database,
      resolveSqliteTranscriptScope(scope),
      scope,
      input.entry,
      input.initialWriterRunId,
    );
    if (!initialEntry.owned) {
      throw new Error("Session actor initializer lost its session identity");
    }
    if (absent && !heldTranscript) {
      // Acquire only previously unheld transcript facts after the initializer claims its target.
      // A retained tombstone window already carries the complete hydrated preimage.
      Object.assign(
        state,
        hydrateSessionActorState(
          database,
          state.hot.target,
          state.hot.version,
          state.hot.writeToken,
        ),
      );
    }
  }
  const scopeForAppend = (scope: SessionActorAppend["input"]["scope"]) => {
    const bound = bindScope(scope);
    if (state.hot.entry?.sessionId !== bound.sessionId) {
      throw new Error("Session actor append lost its session identity");
    }
    return { ...bound, ...initialEntry?.fence };
  };
  const metadata = (input: SessionMetadataOperations["session.metadata.append"]["input"]) => {
    const scoped = { ...input, scope: scopeForAppend(input.scope) };
    const result = runWithCliHistoryWriter(
      input.cliWriter
        ? {
            ...input.cliWriter,
            target: scoped.scope,
            assertCurrent: () => context.admit("transaction"),
            assertReadable: () => context.admit("transaction"),
          }
        : undefined,
      () =>
        runWithMetadataMessageAdmission(messageContext, input.message, (authorize, beforeFresh) => {
          authorize("transaction");
          const value = applySessionMetadataAppendInTransaction(database, scoped, beforeFresh);
          authorize("commit");
          value.pendingInputReceipt = readSessionPendingInputWorkerReceipt(database);
          return value;
        }),
    );
    const value = result.value;
    if (input.view && sessionMetadataAppendNeedsReload(input, value)) {
      try {
        value.reload = {
          ok: true,
          value: runWithSessionTranscriptReadFence(input.view.admission, () =>
            readSessionManagerReload(
              scoped.scope,
              input.view?.limits,
              input.view?.admission !== undefined,
              database,
            ),
          ),
        };
        serialize(value);
      } catch (error) {
        value.reload = {
          ok: false,
          error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        };
      }
    }
    return value;
  };
  let header: SessionActorAppendCommitted["header"];
  if (append.header) {
    if (decodeMetadataAppendEvent(append.header).type !== "session") {
      throw new Error("Session actor header must be a session event");
    }
    header = metadata(append.header);
    if (!header.snapshot.ok) {
      throw new Error("Session actor header was refused");
    }
  }
  if (append.kind === "metadata") {
    return { kind: "metadata", value: metadata(append.input), initialEntry, header };
  }
  const input = { ...append.input, scope: scopeForAppend(append.input.scope) };
  const result = runWithCliHistoryWriter(
    input.cliWriter
      ? {
          ...input.cliWriter,
          target: input.scope,
          assertCurrent: () => context.admit("transaction"),
          assertReadable: () => context.admit("transaction"),
        }
      : undefined,
    () =>
      runWithMetadataMessageAdmission(messageContext, input, (authorize, beforeFresh) => {
        authorize("transaction");
        const value = applySessionDirectMessageInTransaction(database, input, beforeFresh);
        authorize("commit");
        value.pendingInputReceipt = readSessionPendingInputWorkerReceipt(database);
        return value;
      }),
  );
  return { kind: "message", value: result.value, initialEntry, header };
}
