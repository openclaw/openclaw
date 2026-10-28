import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  applySessionGoalOperation,
  prepareSessionTurnGoalMessage,
} from "./goals-operation-policy.js";
import {
  readSessionGoalOperationReceipt,
  writeSessionGoalOperationReceipt,
} from "./goals-operation-receipts.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import {
  readQualifiedSessionEntryRow,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { captureSessionEntrySnapshot } from "./session-accessor.sqlite-entry-snapshot.js";
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
import {
  appendTranscriptMessageInTransaction,
  appendFreshLinearTranscriptMessagesInTransaction,
} from "./session-accessor.sqlite-transcript-message-append.js";
import {
  rememberCommittedTranscriptMessageSequencesInTransaction,
  installCommittedTranscriptMessageSequences,
} from "./session-accessor.sqlite-transcript-sequences.js";
import type {
  SessionTranscriptTurnMessageAppend,
  TranscriptMessageAppendResult,
  ResolvedSessionTranscriptRuntimeTarget,
} from "./session-accessor.types.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import {
  readTranscriptAppendPostimage,
  type TranscriptAppendPostimage,
} from "./session-transcript-append-postimage.js";
import {
  buildExpectedTranscriptTurnSessionPatch,
  prepareSessionTranscriptTurnEntry,
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
  requested: ResolvedTranscriptScope,
  options: SqliteSessionTurnOptions,
  assertRouting?: (database: OpenClawAgentDatabase) => void,
) {
  const { initialEntry, resolveExpectedEntry } = prepareSessionTranscriptTurnEntry(options);
  const readEntry = (
    database: Parameters<typeof readSessionEntryRow>[0],
    includeWindowFacts?: true,
    target = requested,
  ) => {
    const selected =
      options.keyFormat === "agent-qualified"
        ? readQualifiedSessionEntryRow(database, target.agentId, target.sessionKey, {
            includeWindowFacts,
            allowCanonicalMove: options.resolveRuntimeTarget,
          })
        : readSessionEntryRow(database, target.sessionKey, "full", includeWindowFacts);
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
      validateSelected?: (
        selected: ResolvedSessionEntryRow | undefined,
        resolved: ResolvedTranscriptScope,
      ) => void,
    ) {
      const mutation = options.sessionTurnMutation;
      options.assertCurrent?.();
      mutation?.assertCurrent?.();
      assertRouting?.(transactionDb);
      let resolved = requested;
      let selected = readEntry(transactionDb, true);
      let runtimeTarget: ResolvedSessionTranscriptRuntimeTarget | undefined;
      if (options.resolveRuntimeTarget) {
        // The writer already holds its advisory lock. A shared ID's window,
        // not the requested node, decides which physical key receives the turn.
        const window = selected?.row.window;
        const persistedKey =
          window?.session_id === requested.sessionId
            ? window.session_key
            : readSessionKeyBySessionIdInDatabase(transactionDb, requested.sessionId);
        const sessionKey = persistedKey ?? selected?.row.session_key ?? requested.sessionKey;
        resolved = { ...requested, sessionKey };
        if (sessionKey !== requested.sessionKey && selected?.row.session_key !== sessionKey) {
          selected = readEntry(transactionDb, true, resolved);
        }
        runtimeTarget = {
          agentId: resolved.agentId,
          sessionId: resolved.sessionId,
          sessionKey,
          storePath: transactionDb.path,
          selectedSessionId: selected?.entry.sessionId ?? null,
          selectedLifecycleRevision: selected?.entry.lifecycleRevision ?? null,
        };
      }
      const fresh = selected;
      const resultForTarget = (result: SqliteExpectedSessionTranscriptTurnResult) =>
        runtimeTarget
          ? { ...result, runtimeTarget, sessionFile: runtimeTarget.sessionKey }
          : result;
      const commit = () => {
        let result: SqliteExpectedSessionTranscriptTurnResult;
        validateSelected?.(fresh, resolved);
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
            return { result: resultForTarget(result) };
          }
          result = {
            appendedMessages: [],
            sessionEntry: fresh.entry,
            sessionFile: options.sessionFile,
            sessionTurnMutationResult: { result: replay, replayed: true },
          };
          return { result: resultForTarget(result) };
        }
        const currentEntry = resolveExpectedEntry(fresh);
        if (!currentEntry) {
          result = sqliteSessionTranscriptTurnRebound(fresh, options.sessionFile);
          return { result: resultForTarget(result) };
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
        let postimage: TranscriptAppendPostimage | undefined;
        const batch =
          !mutation && !options.assertCurrent
            ? appendFreshLinearTranscriptMessagesInTransaction(
                transactionDb,
                resolved,
                messages.map((append) => ({
                  ...append,
                  cwd: append.cwd ?? options.cwd,
                  config: append.config ?? options.config,
                })),
                projection,
              )
            : undefined;
        if (batch) {
          for (const appended of batch.commits) {
            appendedMessages.push(appended.result);
            postimage = readTranscriptAppendPostimage(appended);
          }
        }
        for (const append of batch ? [] : messages) {
          const {
            shouldAppend: _shouldAppend,
            shouldAppendInTransaction,
            ...appendOptions
          } = append;
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
          if (!sessionTurnPredicateMatches(transactionDb, resolved, append, currentEntry)) {
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
              ...((append.cwd ?? options.cwd) ? { cwd: append.cwd ?? options.cwd } : {}),
              ...((append.config ?? options.config)
                ? { config: append.config ?? options.config }
                : {}),
            },
            undefined,
            projection,
          );
          if (appended) {
            appendedMessages.push(appended.result);
            postimage = readTranscriptAppendPostimage(appended);
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

        options.assertCurrent?.();

        // Later explicit parents can abandon earlier rows. Capture every cursor
        // from the final active projection before this atomic transaction commits.
        if (batch) {
          installCommittedTranscriptMessageSequences(appendedMessages, batch.sequences);
        } else {
          rememberCommittedTranscriptMessageSequencesInTransaction(
            transactionDb,
            resolved.sessionId,
            appendedMessages,
            postimage,
          );
        }

        // Append-owned metadata (including history coverage) is part of this same
        // transaction. Do not overwrite it with the pre-append entry snapshot.
        const appended =
          batch?.version && fresh?.row.window
            ? {
                entry: fresh.entry,
                row: {
                  ...fresh.row,
                  window: {
                    ...fresh.row.window,
                    updated_at: batch.windowUpdatedAt ?? fresh.row.window.updated_at,
                    transcript_updated_at: batch.version.updatedAt,
                  },
                  transcriptWatermark: {
                    sessionId: resolved.sessionId,
                    generation: batch.version.generation,
                    maxSeq: batch.version.rawSeq,
                  },
                },
              }
            : readEntry(transactionDb, true, resolved);
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
        const postimages: SessionEntryWritePostimages = new Map();
        let identity:
          | { previous: Map<string, SessionEntry>; current: Map<string, SessionEntry> }
          | undefined;
        const writesEntry = initialEntry || next !== appendedEntry;
        // Deferred turns publish this locked postimage even without a metadata
        // patch, so the next turn can reuse its scoped-token entry admission.
        if (
          runtimeTarget ||
          writesEntry ||
          !sqliteSessionEntriesEqual(currentEntry, appendedEntry)
        ) {
          const identityKeys = collectSessionEntryLookupKeys(resolved.sessionKey);
          const previousIdentity = readSessionIdentitySnapshot(
            transactionDb,
            identityKeys.filter((key) => key !== resolved.sessionKey),
          );
          // The selected row is still current in this write reservation; read only its siblings.
          if (appended) {
            previousIdentity.set(resolved.sessionKey, appended.entry);
          }
          const snapshot = appended ? captureSessionEntrySnapshot(appended) : undefined;
          const persisted = writesEntry
            ? writeSessionEntry(transactionDb, resolved.sessionKey, next, {
                canonicalPreviousEntry: previousIdentity.get(resolved.sessionKey) ?? null,
                canonicalPreviousRow: snapshot?.row,
                canonicalPreviousWindow: snapshot?.window,
                canonicalPreviousSideTables: snapshot?.sideTables,
                postimages,
              })
            : appendedEntry;
          const currentIdentity = new Map(previousIdentity);
          currentIdentity.set(resolved.sessionKey, persisted);
          if (!writesEntry && appended && snapshot?.window?.row && snapshot.sideTables) {
            postimages.set(resolved.sessionKey, {
              changed: !sqliteSessionEntriesEqual(currentEntry, appendedEntry),
              entry: appendedEntry,
              row: appended.row,
              window: snapshot.window.row,
              sideTables: snapshot.sideTables,
            });
          }
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
        return { result: resultForTarget(result), identity, postimages };
      };
      return runtimeTarget
        ? withSqliteDatabaseWriteScope(
            transactionDb.db,
            [
              requested.sessionKey,
              resolved.sessionKey,
              sqliteSessionIdWriteScope(resolved.sessionId),
            ],
            commit,
          )
        : commit();
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
