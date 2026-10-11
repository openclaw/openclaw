import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { serialize } from "node:v8";
import {
  readSqliteDatabasePendingScopedWriteToken,
  readSqliteDatabaseScopedWriteToken,
  readSqliteDatabaseWriteRevision,
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type {
  SessionActorOperations,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { observeSessionActorCommand } from "./session-actor-diagnostics.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  hydrateSessionActorState,
  projectSessionActorHotState,
} from "./session-actor-hydration.worker.js";
import {
  applySessionActorPhase,
  SessionActorStaleStateError,
} from "./session-actor-phase.worker.js";
import { createSessionActorCommittedOutcome } from "./session-actor-receipt.js";
import {
  cloneSessionActorStoredState,
  withSessionActorTransactionState,
} from "./session-actor-transaction.js";
import { prepareSessionTurnPredicates } from "./session-turn-predicate.js";
import { prepareVoiceTranscriptCommit } from "./session-turn.worker.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

type Command = SqliteWorkerCommand<SessionActorOperations>;
const MAX_RESIDENT_SESSIONS = 128;
const MAX_RESIDENT_BYTES = 8 * 1024 * 1024;

function errorFacts(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "Session actor command failed" };
}

/** One instance belongs to the already serialized physical agent execution worker. */
export function createSessionActorWorker(
  context: AgentWorkerOperationContext,
  physicalIdentity: () => SessionActorTarget["database"],
) {
  const residents = new Map<string, { state: SessionActorStoredState; bytes: number }>();
  let residentBytes = 0;
  let closed = false;
  const drop = (key: string) => {
    residentBytes -= residents.get(key)?.bytes ?? 0;
    residents.delete(key);
  };
  const remember = (state: SessionActorStoredState) => {
    const key = state.hot.target.sessionKey;
    drop(key);
    const bytes = serialize(state).byteLength;
    residents.set(key, { state, bytes });
    residentBytes += bytes;
    // Keep one oversized working set until another key displaces it; dropping it
    // here would make every read-to-command version check fail after rehydration.
    for (const oldest of residents.keys()) {
      if (
        residents.size <= MAX_RESIDENT_SESSIONS &&
        (residents.size <= 1 || residentBytes <= MAX_RESIDENT_BYTES)
      ) {
        break;
      }
      drop(oldest);
    }
  };
  const scopes = (target: SessionActorTarget, sessionIds: readonly string[] = []) => [
    ...collectSessionEntryLookupKeys(target.sessionKey),
    ...sessionIds.map(sqliteSessionIdWriteScope),
  ];
  const token = (
    database: OpenClawAgentDatabase,
    target: SessionActorTarget,
    sessionIds?: readonly string[],
  ) => readSqliteDatabaseScopedWriteToken(database.db, scopes(target, sessionIds));
  const requireTarget = (target: SessionActorTarget) => {
    const current = physicalIdentity();
    const requested = target.database;
    const matches =
      current.kind === "file" &&
      requested.kind === "file" &&
      current.physicalIdentity === requested.physicalIdentity &&
      current.birthtime === requested.birthtime &&
      current.nativeLocation === requested.nativeLocation;
    if (closed || !matches) {
      throw new Error("Session actor lost its physical database owner");
    }
  };
  const read = (database: OpenClawAgentDatabase, target: SessionActorTarget) => {
    requireTarget(target);
    const resident = residents.get(target.sessionKey)?.state;
    const currentToken = token(database, target, resident?.hot.dependencySessionIds);
    if (!currentToken) {
      // The shared fence can belong to another session; retain this preimage privately.
      throw new Error("Session actor has an unsettled database writer");
    }
    if (resident?.hot.writeToken === currentToken) {
      const held = residents.get(target.sessionKey)!;
      residents.delete(target.sessionKey);
      residents.set(target.sessionKey, held);
      return resident;
    }
    drop(target.sessionKey);
    const revision = readSqliteDatabaseWriteRevision(database.db);
    const hydrated = hydrateSessionActorState(
      database,
      target,
      { epoch: randomUUID(), sequence: 0 },
      currentToken,
    );
    const hydratedToken = token(database, target, hydrated.hot.dependencySessionIds);
    if (
      !hydratedToken ||
      revision === undefined ||
      readSqliteDatabaseWriteRevision(database.db) !== revision
    ) {
      throw new Error("Session actor changed while hydrating");
    }
    hydrated.hot.writeToken = hydratedToken;
    remember(hydrated);
    return hydrated;
  };
  return {
    async prepare(command: Command) {
      if (command.type === "session.actor.read") {
        return;
      }
      await prepareSessionTurnPredicates();
      if ("turn" in command.input && command.input.turn?.options.voiceTranscript) {
        await prepareVoiceTranscriptCommit();
      }
    },
    execute(command: Command): SessionActorOperations[keyof SessionActorOperations]["output"] {
      // SAFETY: Every command in the closed operations union uses this prefix and a phase or read suffix.
      const phase = command.type.slice("session.actor.".length) as SessionActorPhase | "read";
      const observed = observeSessionActorCommand(phase);
      const target = command.input.target;
      let database: OpenClawAgentDatabase | undefined;
      let committed:
        | Extract<
            SessionActorOutcome<ReturnType<typeof applySessionActorPhase>["value"]>,
            { kind: "committed" }
          >
        | undefined;
      let stale: Extract<SessionActorOutcome<never>, { kind: "stale-version" }> | undefined;
      try {
        database = context.open();
        requireTarget(target);
        const opened = database;
        if (command.type === "session.actor.read") {
          const before = read(database, target);
          context.admit("transaction", { kind: "session-actor-admission", snapshot: before.hot });
          observed.settled("read");
          return structuredClone(before.hot);
        }
        const outcome = context.writeTransaction(`session.actor.${phase}`, "Session actor", () => {
          const admit = (stage: "transaction" | "commit", publication: unknown) => {
            const revision = readSqliteNativeMutationRevision(opened.db);
            withoutSqliteDatabaseWriteScope(opened.db, () => context.admit(stage, publication));
            if (readSqliteNativeMutationRevision(opened.db) !== revision) {
              throw new Error("Session actor database changed during authority admission");
            }
          };
          // The writer owns both hydration and version validation. A replica miss
          // never requires a separate read command before this transaction.
          const before = read(opened, target);
          admit("transaction", { kind: "session-actor-admission", snapshot: before.hot });
          if (
            command.input.expected !== undefined &&
            !isDeepStrictEqual(before.hot.version, command.input.expected)
          ) {
            const error = new Error("Session actor version changed before command admission");
            error.name = "SessionActorStaleVersionError";
            stale = {
              kind: "stale-version",
              expected: command.input.expected,
              postimage: structuredClone(before.hot),
              error: errorFacts(error),
            };
            throw error;
          }
          const working = cloneSessionActorStoredState(before);
          let commitPublication: unknown;
          const borrowed: AgentWorkerOperationContext = {
            ...context,
            open: () => opened,
            writeTransaction(_label, _owner, operation) {
              if (!opened.db.isTransaction) {
                throw new Error("Session actor kernel escaped its transaction");
              }
              return operation(opened);
            },
            admit(stage, publication) {
              if (stage === "commit") {
                commitPublication = publication;
              }
              admit(stage, {
                kind: "session-actor-admission",
                snapshot: projectSessionActorHotState(working),
                publication,
              });
            },
          };
          return withSessionActorTransactionState(opened, working, () => {
            const applied = applySessionActorPhase(command, working, borrowed);
            const { value } = applied;
            working.hot.version = {
              epoch: before.hot.version.epoch,
              sequence: before.hot.version.sequence + 1,
            };
            working.hot = projectSessionActorHotState(working);
            const pendingToken = readSqliteDatabasePendingScopedWriteToken(
              opened.db,
              scopes(target, working.hot.dependencySessionIds),
            );
            if (pendingToken === undefined) {
              throw new Error("Session actor lost its native writer revision");
            }
            working.hot.writeToken = pendingToken;
            const accepted = createSessionActorCommittedOutcome({
              // SAFETY: The read command returned before entering this write transaction.
              phase: phase as SessionActorPhase,
              command: command.input,
              before: before.hot,
              after: working.hot,
              applied,
            });
            if (
              !stageSqliteTransactionState(opened.db, {
                stage() {},
                rollback() {},
                commit() {
                  committed = accepted;
                  remember(working);
                },
                invalidate() {
                  drop(target.sessionKey);
                },
              })
            ) {
              throw new Error("Session actor requires managed transaction settlement");
            }
            deferSqliteWorkerCommitReceipt(opened.db, accepted);
            const turn =
              value && "kind" in value && value.kind === "session-turn"
                ? value
                : value && "turn" in value
                  ? value.turn
                  : undefined;
            admit("commit", {
              kind: "session-actor-admission",
              snapshot: projectSessionActorHotState(working),
              publication: turn ?? commitPublication,
              final: true,
            });
            return accepted;
          });
        });
        observed.settled(outcome.kind);
        return outcome;
      } catch (error) {
        if (command.type === "session.actor.read") {
          observed.settled("rejected");
          throw error;
        }
        if (committed) {
          observed.settled("committed");
          return { ...committed, failure: errorFacts(error) };
        }
        let unsettled = hasSqliteWorkerOutcomeUnknown(error);
        if (database) {
          try {
            // The transaction owner retires the handle if rollback cannot establish settlement.
            assertTransactionUsable(database.db);
            unsettled ||= database.db.isTransaction || !database.db.isOpen;
          } catch {
            unsettled = true;
          }
        }
        if (unsettled) {
          drop(target.sessionKey);
          observed.settled("unknown");
          return {
            kind: "unknown",
            target,
            commandId: command.input.commandId,
            error: errorFacts(error),
          };
        }
        const retained = residents.get(target.sessionKey)?.state;
        if (retained && database) {
          const currentToken = token(database, target, retained.hot.dependencySessionIds);
          if (currentToken !== undefined && currentToken !== retained.hot.writeToken) {
            drop(target.sessionKey);
          }
        }
        if (stale) {
          observed.settled("stale-version");
          return stale;
        }
        observed.settled("rolled-back");
        return {
          kind: "rolled-back",
          error: errorFacts(error),
          ...(error instanceof SessionActorStaleStateError
            ? { reason: "stale-state" as const }
            : {}),
        };
      }
    },
    close() {
      // Commands are synchronous. The execution owner drains accepted requests before close;
      // staged reducers remain with retained host phases and must settle before their release.
      closed = true;
      residents.clear();
      residentBytes = 0;
    },
  };
}
