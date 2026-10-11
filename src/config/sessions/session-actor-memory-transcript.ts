import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  decodeMetadataAppendEvent,
  sessionMetadataAppendNeedsReload,
} from "../../agents/sessions/session-manager-append-codec.js";
import type { SessionMessageEntry } from "../../agents/sessions/session-manager-types.js";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import { runWithCliHistoryWriter, type CliHistoryWriterFacts } from "./cli-history-boundary.js";
import {
  applySessionGoalOperation,
  prepareSessionTurnGoalMessage,
} from "./goals-operation-policy.js";
import type { TranscriptMessageAppendResult } from "./session-accessor.types.js";
import type { SessionActorAppend, SessionActorAppendCommitted } from "./session-actor-contract.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { createSessionActorMemoryGoals } from "./session-actor-memory-goals.js";
import { readSessionActorMemoryHistory } from "./session-actor-memory-history.js";
import { createSessionActorMemoryMessages } from "./session-actor-memory-messages.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type { SessionActorPhaseBackend } from "./session-actor-phase.js";
import { isReadableSessionMessage } from "./session-entry-codec.js";
import type {
  InitialSessionEntryCommit,
  SessionMetadataOperations,
} from "./session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import type { SessionPendingInputWorkerReceipt } from "./session-pending-input.types.js";
import {
  buildExpectedTranscriptTurnSessionPatch,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { SessionTurnCommitted, SessionTurnPlan } from "./session-turn.types.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import { selectSessionTranscriptTreePathNodes } from "./transcript-tree.js";
import { mergeSessionEntry } from "./types.js";

type MetadataInput = SessionMetadataOperations["session.metadata.append"]["input"];

function readableResult(
  result: TranscriptMessageAppendResult<unknown> | undefined,
  custody?: SessionPendingInputWorkerReceipt,
) {
  if (!result) {
    return undefined;
  }
  const message = result.appended && !custody ? undefined : result.message;
  if (message !== undefined && !isReadableSessionMessage(message)) {
    throw new Error("Invalid serialized session transcript message");
  }
  return { ...result, message };
}

/** The actor's transaction owns this working copy; no operation opens a database. */
export function createSessionActorMemoryTranscript(options: {
  state: SessionActorMemoryState;
  agentId: string;
  path: string;
  admit: SessionActorPhaseBackend["admit"];
  validateSources: SessionActorPhaseBackend["validateSources"];
}): Pick<SessionActorPhaseBackend, "turn" | "append" | "appendEvent"> {
  const { state, agentId, path, admit, validateSources } = options;
  const pending = createSessionActorMemoryPending(state, options);
  const goals = createSessionActorMemoryGoals(options);
  const events = createSessionActorMemoryEvents(options);
  const { version, tree, rebasePrepared, appendRaw } = events;
  const { findByKey, appendMessage } = createSessionActorMemoryMessages(options, events);
  const requireEntry = () => {
    if (!state.hot.entry) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return state.hot.entry;
  };
  const bindScope = (scope: MetadataInput["scope"]) => {
    if (
      (scope.agentId !== undefined && scope.agentId !== agentId) ||
      (scope.sessionKey !== undefined && scope.sessionKey !== state.hot.target.sessionKey) ||
      (scope.storePath !== undefined && scope.storePath !== path) ||
      !sessionMatchesExpectedTranscriptTurn(
        state.hot.entry ? { entry: state.hot.entry } : undefined,
        { ...scope, expectedSessionId: scope.sessionId },
      )
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  const withCliWriter = <T>(
    writer: CliHistoryWriterFacts | undefined,
    sessionId: string,
    run: () => T,
  ): T =>
    runWithCliHistoryWriter(
      writer
        ? {
            ...writer,
            target: {
              agentId,
              storePath: path,
              sessionKey: state.hot.target.sessionKey,
              sessionId,
            },
            assertCurrent: () => admit("transaction"),
            assertReadable: () => admit("transaction"),
          }
        : undefined,
      run,
    );
  const metadata = (
    input: MetadataInput,
  ): SessionMetadataOperations["session.metadata.append"]["output"] => {
    bindScope(input.scope);
    const event = decodeMetadataAppendEvent(input);
    const before = version();
    let result:
      | TranscriptMessageAppendResult<SessionMessageEntry["message"] | undefined>
      | ReturnType<typeof appendRaw>
      | undefined;
    let receipt: SessionPendingInputWorkerReceipt | undefined;
    if (event.type === "message" && input.message) {
      if (input.message.validateTurn && !rebasePrepared(input, event.parentId)) {
        throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
      }
      const appended = appendMessage({
        ...input.options,
        expectedMutationAt: input.message.validateTurn
          ? undefined
          : input.options.expectedMutationAt,
        message: event.message,
        messageJson: input.message.messageJson,
        eventId: event.id,
        parentId: event.parentId,
        now: Date.parse(event.timestamp),
        cwd: input.message.cwd,
        idempotencyLookup: input.message.idempotencyLookup,
        custody: input.message.pendingInput,
        fresh: input.message.freshMessageCheck
          ? () => admit("transaction", { kind: "session-message", check: "fresh" })
          : undefined,
      });
      result = readableResult(appended.result, appended.receipt);
      receipt = appended.receipt;
    } else {
      result = appendRaw(
        event,
        input.options,
        typeof input.event === "string" ? input.event : undefined,
      );
    }
    const value: SessionMetadataOperations["session.metadata.append"]["output"] = {
      snapshot: {
        ok: true,
        value: {
          result,
          before,
          after: version(),
          lifecycleRevision: requireEntry().lifecycleRevision,
        },
      },
      projectionNeedsReconcile: false,
      pendingInputReceipt: receipt,
    };
    if (input.view && sessionMetadataAppendNeedsReload(input, value)) {
      try {
        value.reload = { ok: true, value: readSessionActorMemoryHistory(state, input.view.limits) };
      } catch (error) {
        // Pure reload failures are ordinary errors or limit RangeErrors; keep append success
        // without importing the native database error registry into the memory backend.
        const reloadError: OpenClawStateWorkerErrorPayload | undefined =
          error instanceof Error
            ? {
                version: 1,
                root: 0,
                nodes: [
                  {
                    type: error instanceof RangeError ? "range-error" : "error",
                    name: error.name,
                    message: error.message,
                  },
                ],
              }
            : undefined;
        value.reload = {
          ok: false,
          error: reloadError,
        };
      }
    }
    return value;
  };
  return {
    append(append: SessionActorAppend): SessionActorAppendCommitted {
      return withCliWriter(append.input.cliWriter, append.input.scope.sessionId, () => {
        let initialEntry: InitialSessionEntryCommit | undefined;
        if (append.initialization) {
          const input = append.initialization;
          if (
            input.scope.sessionId !== append.input.scope.sessionId ||
            input.entry.sessionId !== input.scope.sessionId ||
            (input.scope.agentId !== undefined && input.scope.agentId !== agentId) ||
            (input.scope.sessionKey !== undefined &&
              input.scope.sessionKey !== state.hot.target.sessionKey) ||
            (input.scope.storePath !== undefined && input.scope.storePath !== path)
          ) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          if (state.hot.entry) {
            if (
              input.initialWriterRunId !== undefined ||
              state.hot.entry.sessionId !== input.entry.sessionId
            ) {
              throw new SessionTranscriptWriterClaimReboundError();
            }
            initialEntry = { owned: true };
          } else {
            if (
              input.scope.expectedWriterRunId !== undefined &&
              input.initialWriterRunId === undefined
            ) {
              throw new SessionTranscriptWriterClaimReboundError();
            }
            state.hot.entry = {
              ...structuredClone(input.entry),
              ...(input.initialWriterRunId !== undefined
                ? { activeWriterRunId: input.initialWriterRunId }
                : {}),
            };
            initialEntry = {
              owned: true,
              ...(input.initialWriterRunId !== undefined
                ? {
                    fence: {
                      expectedLifecycleRevision: state.hot.entry.lifecycleRevision,
                      expectedWriterRunId: input.initialWriterRunId,
                    },
                  }
                : {}),
              identity: {
                previous: new Map(),
                current: new Map([[state.hot.target.sessionKey, structuredClone(state.hot.entry)]]),
              },
            };
          }
        }
        const header = append.header
          ? (() => {
              if (decodeMetadataAppendEvent(append.header).type !== "session") {
                throw new Error("Session actor header must be a session event");
              }
              return metadata({
                ...append.header,
                scope: { ...append.header.scope, ...initialEntry?.fence },
              });
            })()
          : undefined;
        const input = { ...append.input, scope: { ...append.input.scope, ...initialEntry?.fence } };
        if (append.kind === "metadata") {
          return {
            kind: "metadata",
            value: metadata({ ...append.input, scope: input.scope }),
            initialEntry,
            header,
          };
        }
        bindScope(input.scope);
        const message: unknown = JSON.parse(append.input.messageJson);
        if (!isReadableSessionMessage(message)) {
          throw new Error("Invalid serialized session transcript message");
        }
        const before = version();
        const appended = appendMessage({
          message,
          messageJson: append.input.messageJson,
          cwd: append.input.cwd,
          custody: append.input.pendingInput,
          fresh: append.input.freshMessageCheck
            ? () => admit("transaction", { kind: "session-message", check: "fresh" })
            : undefined,
        });
        return {
          kind: "message",
          initialEntry,
          header,
          value: {
            snapshot: {
              ok: true,
              value: {
                result: readableResult(appended.result, appended.receipt),
                before,
                after: version(),
                lifecycleRevision: requireEntry().lifecycleRevision,
                visibleTail: { entryId: tree().leafId, generation: version().generation },
              },
            },
            projectionNeedsReconcile: false,
            pendingInputReceipt: appended.receipt,
          },
        };
      });
    },
    appendEvent(input) {
      const entry = requireEntry();
      if (
        entry.sessionId !== input.sessionId ||
        (entry.lifecycleRevision ?? null) !== input.lifecycleRevision ||
        (input.writerRunId !== undefined && input.writerRunId !== entry.activeWriterRunId)
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      const event: unknown = JSON.parse(input.eventJson);
      if (isRecord(event) && event.type === "message") {
        throw new Error("Raw event append cannot write transcript messages");
      }
      appendRaw(event, {}, input.eventJson);
      return { projectionNeedsReconcile: false };
    },
    turn(input: SessionTurnPlan): SessionTurnCommitted {
      return withCliWriter(input.cliWriter, input.options.expectedSessionId, () => {
        const opts = input.options;
        if (opts.voiceTranscript) {
          // Incognito voice metadata deliberately stays with the separate durable voice worker.
          throw new Error(
            "Incognito transcript commits confirm Talk metadata through the durable voice worker",
          );
        }
        const mutation = opts.sessionTurnMutation;
        goals.assertRouting(mutation?.routingPredicate);
        const previous = state.hot.entry;
        if (input.ownerSources?.length) {
          const sourceValidation = validateSources(input.ownerSources);
          if (sourceValidation.refusedSource) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          admit("transaction", { kind: "session-turn-owner", sourceValidation });
        }
        const replay = mutation
          ? goals.readReceipt(opts.expectedSessionId, mutation.operation)
          : undefined;
        if (replay && previous?.sessionId === opts.expectedSessionId) {
          return {
            kind: "session-turn",
            result: {
              appendedMessages: [],
              sessionEntry: structuredClone(previous),
              sessionFile: opts.sessionFile,
              sessionTurnMutationResult: { result: replay, replayed: true },
            },
            sequences: [],
            projectionNeedsReconcile: false,
          };
        }
        if (
          opts.initialSessionEntry &&
          (previous ||
            opts.initialSessionEntry.sessionId !== opts.expectedSessionId ||
            opts.expectedLifecycleRevision !== undefined ||
            opts.expectedWriterRunId !== undefined ||
            opts.expectedSessionState !== undefined)
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        if (
          opts.selectedSessionId !== undefined &&
          ((previous?.sessionId ?? null) !== opts.selectedSessionId ||
            previous?.lifecycleRevision !== (opts.selectedLifecycleRevision ?? undefined))
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        if (
          !opts.initialSessionEntry &&
          !sessionMatchesExpectedTranscriptTurn(previous ? { entry: previous } : undefined, opts)
        ) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        if (opts.initialSessionEntry) {
          state.hot.entry = structuredClone(opts.initialSessionEntry);
        }
        const entry = requireEntry();
        if (opts.acceptedResultGuard) {
          const error = resolveSessionWorkStartError(state.hot.target.sessionKey, entry, {
            expectedSessionId: opts.expectedSessionId,
            purpose: "accepted-result-settlement",
          });
          if (
            entry.activeWriterRunId !==
              (opts.acceptedResultGuard.expectedWriterRunId ?? undefined) ||
            error
          ) {
            throw new Error(error ?? opts.acceptedResultGuard.errorMessage);
          }
        }
        const goal = mutation
          ? applySessionGoalOperation(entry, mutation.operation, Date.now())
          : undefined;
        if (goal && opts.preparedGoalId) {
          goal.id = opts.preparedGoalId;
        }
        const transactionVersion = version();
        for (const append of opts.messages) {
          if (!append.preparedMessage?.prepared) {
            continue;
          }
          const event = findByKey(append);
          const current = event ? { messageId: event.id, message: event.message } : undefined;
          if (!isDeepStrictEqual(current, append.preparedMessage.expected)) {
            throw new Error("Transcript idempotency changed while preparing the turn");
          }
        }
        let custody: SessionPendingInputWorkerReceipt | undefined;
        const appendedMessages: TranscriptMessageAppendResult<unknown>[] = [];
        let predicateSkipped = false;
        for (const [index, append] of opts.messages.entries()) {
          const predicate = append.predicate;
          if (predicate?.kind === "active-entry") {
            if (
              !state.hot.transcript.anchors.some((anchor) => anchor.entryId === predicate.entryId)
            ) {
              throw new Error(predicate.errorMessage);
            }
          } else if (predicate) {
            const latest = selectSessionTranscriptTreePathNodes(tree(), tree().leafId).findLast(
              ({ entry: event }) =>
                isRecord(event) &&
                event.type === "message" &&
                isRecord(event.message) &&
                event.message.role === "assistant",
            )?.entry;
            const message = isRecord(latest) ? latest.message : undefined;
            if (
              resolveTerminalAssistantTranscriptRunId(
                message,
                readSessionTranscriptRunId(message),
              ) === predicate.runId &&
              extractAssistantPhaseText(message)?.trim() === predicate.text
            ) {
              predicateSkipped = true;
              continue;
            }
          }
          const committed = appendMessage({
            ...append,
            message: prepareSessionTurnGoalMessage(append.message, mutation, goal?.id),
            cwd: append.cwd ?? opts.cwd,
            custody: input.custody
              ? { facts: input.custody, relocation: input.relocation }
              : undefined,
            fresh: () => {
              if (
                (append.preparedMessage && !append.preparedMessage.prepared) ||
                (append.preparationVersion &&
                  !isDeepStrictEqual(append.preparationVersion, transactionVersion))
              ) {
                throw new SqliteTranscriptMutationConflictError(entry.sessionId);
              }
              if (append.freshGuard) {
                const sourceValidation = validateSources(append.sources);
                if (sourceValidation.refusedSource) {
                  throw new SessionTranscriptWriterClaimReboundError();
                }
                admit("transaction", { kind: "session-turn-fresh", index, sourceValidation });
              }
            },
          });
          if (committed.result) {
            appendedMessages.push(committed.result);
          }
          if (committed.receipt) {
            custody = {
              transcriptInputId: committed.receipt.transcriptInputId,
              consumedInputIds: [
                ...new Set([
                  ...(custody?.consumedInputIds ?? []),
                  ...committed.receipt.consumedInputIds,
                ]),
              ],
            };
          }
        }
        if (
          opts.atomicGroup &&
          (appendedMessages.length !== opts.messages.length ||
            appendedMessages.some((message) => message.appended) !==
              appendedMessages.every((message) => message.appended))
        ) {
          throw new Error("Transcript batch was not wholly inserted or replayed");
        }
        if (
          (mutation || opts.initialSessionEntry) &&
          (!appendedMessages.length ||
            appendedMessages.length !== opts.messages.length ||
            appendedMessages.some((message) => !message.appended))
        ) {
          throw new Error(
            mutation
              ? "Goal admission requires a new transcript turn in the same transaction."
              : "Session initialization requires a new transcript turn in the same transaction.",
          );
        }
        const patch = {
          ...buildExpectedTranscriptTurnSessionPatch({
            appendedMessages,
            currentEntry: requireEntry(),
            expectedSessionState: opts.expectedSessionState,
            sessionLifecyclePatch: opts.sessionLifecyclePatch,
            touchSessionEntry: opts.touchSessionEntry,
          }),
          ...(mutation ? { goal } : {}),
        };
        state.hot.entry = Object.keys(patch).length
          ? mergeSessionEntry(requireEntry(), patch)
          : requireEntry();
        return {
          kind: "session-turn",
          result: {
            appendedMessages,
            predicateSkipped,
            sessionEntry: structuredClone(state.hot.entry),
            sessionFile: opts.sessionFile,
            transcriptVersion: version(),
            ...(mutation
              ? {
                  sessionTurnMutationResult: {
                    result: goals.commitReceipt(
                      opts.expectedSessionId,
                      mutation.operation,
                      goal,
                      mutation.runId,
                    ),
                    replayed: false,
                  },
                }
              : {}),
          },
          sequences: appendedMessages.map((message) => {
            const position = message.appended
              ? state.hot.transcript.anchors.find((anchor) => anchor.entryId === message.messageId)
                  ?.activeMessagePosition
              : undefined;
            return position === undefined ? undefined : position + 1;
          }),
          projectionNeedsReconcile: false,
          custody,
          ...(input.custody?.preparedAuthority
            ? { authority: pending.authority(input.custody.agentId) }
            : {}),
        };
      });
    },
  };
}
