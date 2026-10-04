import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  applySessionGoalOperation,
  readSessionGoalOperationReceipt,
  writeSessionGoalOperationReceipt,
} from "./goals-operations.js";
import type { SessionTranscriptTurnMutation } from "./goals-operations.types.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { readQualifiedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  readSessionEntryRow,
  readSessionIdentitySnapshot,
  writeSessionEntry,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-store.js";
import {
  findAssistantTranscriptEventInDatabase,
  readTranscriptEventMessage,
} from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { rememberCommittedTranscriptMessageSequencesInTransaction } from "./session-accessor.sqlite-transcript-sequences.js";
import type {
  SessionTranscriptTurnMessageAppend,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import {
  buildExpectedTranscriptTurnSessionPatch,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import {
  sessionTurnPredicateMatches,
  assertSessionTurnAcceptedResult,
} from "./session-turn-predicate.js";
import type {
  SqliteExpectedSessionTranscriptTurnResult,
  SqliteSessionTurnOptions,
} from "./session-turn.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";
import { mergeSessionEntry, type SessionEntry } from "./types.js";

export function createSessionTranscriptTurnKernel(
  resolved: ResolvedTranscriptScope,
  options: SqliteSessionTurnOptions,
  assertRouting?: (database: OpenClawAgentDatabase) => void,
) {
  const initialEntry = options.initialSessionEntry
    ? structuredClone(options.initialSessionEntry)
    : undefined;
  if (
    initialEntry &&
    (initialEntry.sessionId !== options.expectedSessionId ||
      options.expectedLifecycleRevision !== undefined ||
      options.expectedWriterRunId !== undefined ||
      options.expectedSessionState !== undefined)
  ) {
    throw new Error(
      "Session initialization requires its new identity and no existing writer state.",
    );
  }
  const resolveExpectedEntry = (selected: ResolvedSessionEntryRow | undefined) => {
    if (
      options.selectedSessionId !== undefined &&
      ((selected?.entry.sessionId ?? null) !== options.selectedSessionId ||
        selected?.entry.lifecycleRevision !== (options.selectedLifecycleRevision ?? undefined))
    ) {
      return undefined;
    }
    // A prepared creation cannot adopt a row that appeared while admission was awaiting work.
    if (initialEntry) {
      return selected ? undefined : initialEntry;
    }
    return sessionMatchesExpectedTranscriptTurn(selected, options) ? selected.entry : undefined;
  };
  const readEntry = (database: Parameters<typeof readSessionEntryRow>[0]) => {
    const selected =
      options.keyFormat === "agent-qualified"
        ? readQualifiedSessionEntryRow(database, resolved.agentId, resolved.sessionKey)
        : readSessionEntryRow(database, resolved.sessionKey);
    return selected?.entry ? { entry: selected.entry, row: selected.row } : undefined;
  };
  return {
    readEntry,
    resolveExpectedEntry,
    commit(
      this: void,
      transactionDb: OpenClawAgentDatabase,
      messages: readonly SessionTranscriptTurnMessageAppend[],
      projection?: Parameters<typeof appendTranscriptMessageInTransaction>[4],
    ) {
      const mutation = options.sessionTurnMutation;
      options.assertCurrent?.();
      mutation?.assertCurrent?.();
      assertRouting?.(transactionDb);
      let result: SqliteExpectedSessionTranscriptTurnResult;
      const fresh = readEntry(transactionDb);
      const replay = mutation
        ? readSessionGoalOperationReceipt(
            transactionDb.db,
            resolved.sessionKey,
            options.expectedSessionId,
            mutation.operation,
          )
        : undefined;
      if (replay) {
        if (fresh?.entry.sessionId !== options.expectedSessionId) {
          result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
          return { result };
        }
        result = {
          appendedMessages: [],
          sessionEntry: fresh.entry,
          sessionFile: options.sessionFile,
          sessionTurnMutationResult: { result: replay, replayed: true },
        };
        return { result };
      }
      const currentEntry = resolveExpectedEntry(fresh);
      if (!currentEntry) {
        result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
        return { result };
      }
      assertSessionTurnAcceptedResult(resolved.sessionKey, currentEntry, options);
      let predicateSkipped = false;
      const goal = mutation
        ? applySessionGoalOperation(currentEntry, mutation.operation, Date.now())
        : undefined;
      if (goal && options.preparedGoalId) {
        goal.id = options.preparedGoalId;
      }
      const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
      for (const append of messages) {
        const { shouldAppend: _shouldAppend, shouldAppendInTransaction, ...appendOptions } = append;
        if (shouldAppendInTransaction) {
          if (
            !shouldAppendInTransaction(() => {
              const latestAssistant = findAssistantTranscriptEventInDatabase(
                transactionDb,
                resolved.sessionId,
              );
              return latestAssistant
                ? readTranscriptEventMessage(latestAssistant.event)
                : undefined;
            })
          ) {
            continue;
          }
        }
        if (!sessionTurnPredicateMatches(transactionDb, resolved, append.predicate)) {
          predicateSkipped = true;
          continue;
        }
        const message = prepareSessionTurnGoalMessage(appendOptions.message, mutation, goal?.id);
        const appended = appendTranscriptMessageInTransaction(
          transactionDb,
          resolved,
          {
            ...appendOptions,
            ...append.workerPreparation,
            message,
            messageAlreadyRedacted: options.atomicGroup === true || options.workerPrepared === true,
            ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
            ...((append.config ?? options.config)
              ? { config: append.config ?? options.config }
              : {}),
          },
          undefined,
          projection,
        );
        if (appended) {
          appendedMessages.push(appended);
        }
      }
      if (
        options.atomicGroup &&
        (appendedMessages.length !== messages.length ||
          appendedMessages.some((message) => message.appended) !==
            appendedMessages.every((message) => message.appended))
      ) {
        throw new Error("SQLite transcript batch was not wholly inserted or replayed");
      }

      if (
        (mutation || initialEntry) &&
        (appendedMessages.length === 0 ||
          appendedMessages.length !== messages.length ||
          appendedMessages.some((message) => !message.appended))
      ) {
        throw new Error(
          mutation
            ? "Goal admission requires a new transcript turn in the same transaction."
            : "Session initialization requires a new transcript turn in the same transaction.",
        );
      }

      // Later explicit parents can abandon earlier rows. Capture every cursor
      // from the final active projection before this atomic transaction commits.
      rememberCommittedTranscriptMessageSequencesInTransaction(
        transactionDb,
        resolved.sessionId,
        appendedMessages,
      );

      // Append-owned metadata (including history coverage) is part of this same
      // transaction. Do not overwrite it with the pre-append entry snapshot.
      const appended = readEntry(transactionDb);
      const appendedEntry = appended?.entry ?? currentEntry;
      const sessionPatch = buildExpectedTranscriptTurnSessionPatch({
        appendedMessages,
        currentEntry: appendedEntry,
        expectedSessionState: options.expectedSessionState,
        sessionLifecyclePatch: options.sessionLifecyclePatch,
        touchSessionEntry: options.touchSessionEntry,
      });
      if (mutation) {
        sessionPatch.goal = goal;
      }
      const next =
        Object.keys(sessionPatch).length > 0
          ? mergeSessionEntry(appendedEntry, sessionPatch)
          : appendedEntry;
      let identity:
        | { previous: Map<string, SessionEntry>; current: Map<string, SessionEntry> }
        | undefined;
      const writesEntry = initialEntry || next !== appendedEntry;
      if (writesEntry || !sqliteSessionEntriesEqual(currentEntry, appendedEntry)) {
        const identityKeys = collectSessionEntryLookupKeys(resolved.sessionKey);
        const previousIdentity = readSessionIdentitySnapshot(
          transactionDb,
          identityKeys.filter((key) => key !== resolved.sessionKey),
        );
        // The selected row is still current in this write reservation; read only its siblings.
        if (appended) {
          previousIdentity.set(resolved.sessionKey, appended.entry);
        }
        const persisted = writesEntry
          ? writeSessionEntry(transactionDb, resolved.sessionKey, next, {
              canonicalPreviousEntry: previousIdentity.get(resolved.sessionKey) ?? null,
            })
          : appendedEntry;
        const currentIdentity = new Map(previousIdentity);
        currentIdentity.set(resolved.sessionKey, persisted);
        identity = { previous: previousIdentity, current: currentIdentity };
      }
      const sessionTurnMutationResult = mutation
        ? {
            result: writeSessionGoalOperationReceipt(
              transactionDb.db,
              resolved.sessionKey,
              options.expectedSessionId,
              mutation.operation,
              goal,
              mutation.runId,
            ),
            replayed: false,
          }
        : undefined;
      result = {
        sessionTurnMutationResult,
        predicateSkipped,
        appendedMessages,
        sessionEntry: structuredClone(next),
        sessionFile: options.sessionFile,
      };
      return { result, identity };
    },
  };
}

export function sqliteSessionTranscriptTurnRebound(
  selected: ResolvedSessionEntryRow | undefined,
  sessionFile: string,
): SqliteExpectedSessionTranscriptTurnResult {
  return {
    appendedMessages: [],
    rejectedReason: "session-rebound",
    sessionEntry: selected?.entry,
    sessionFile,
  };
}

export function prepareSessionTurnGoalMessage(
  message: unknown,
  mutation: SessionTranscriptTurnMutation | undefined,
  goalId: string | undefined,
): unknown {
  if (!mutation || !goalId || !isRecord(message) || message.role !== "user") {
    return message;
  }
  return {
    ...message,
    __openclaw: {
      ...(isRecord(message["__openclaw"]) ? message["__openclaw"] : {}),
      intent: {
        kind: mutation.operation.action === "start" ? "session-goal-start" : "session-goal-resume",
        version: 1,
        goalId,
        operationId: mutation.operation.operationId,
      },
    },
  };
}
