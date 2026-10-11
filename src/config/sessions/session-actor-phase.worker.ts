import { isDeepStrictEqual } from "node:util";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  hasActiveRestartRecoveryDeliveryClaim,
  hasExactRestartRecoveryDeliveryClaim,
  projectRestartRecoveryDeliverySettlement,
  resolveRestartRecoveryTerminalDeliveryDisposition,
} from "./restart-recovery-receipt-state.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { applySessionActorAppend } from "./session-actor-append.worker.js";
import type {
  SessionActorOperations,
  SessionActorPhase,
  SessionActorPhaseResults,
  SessionActorReducerOutcome,
} from "./session-actor-contract.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import { reduceSessionActorEntry } from "./session-actor-reducers.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import { readHarnessCompletionSourceInDatabase } from "./session-harness-completion-source.kernel.js";
import { applySessionTranscriptEvent } from "./session-message-rewrite.worker.js";
import { projectPendingFinalDeliverySettlement } from "./session-pending-final-settlement.js";
import { mutatePendingInput } from "./session-pending-input-operations.kernel.js";
import type { PendingInputMutationReceipt } from "./session-pending-input-operations.types.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import { sessionMatchesExpectedTranscriptTurn } from "./session-transcript-turn-state.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import { applySessionTurn } from "./session-turn.worker.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type Mutation = Exclude<
  SqliteWorkerCommand<SessionActorOperations>,
  { type: "session.actor.read" }
>;

export class SessionActorStaleStateError extends Error {}

/** The actor lends one transaction; nested kernels retain admission without opening savepoints. */
export function applySessionActorPhase(
  command: Mutation,
  state: SessionActorStoredState,
  context: AgentWorkerOperationContext,
) {
  const database = context.open();
  const sessionKey = state.hot.target.sessionKey;
  const incarnation =
    state.hot.target.database.kind !== "file" ? state.hot.target.database.incarnation : undefined;
  let entryUpdate: SessionEntry | undefined;
  const requireEntry = () => {
    const entry = state.hot.entry;
    if (!entry) {
      throw new Error("Session actor requires an existing session");
    }
    return entry;
  };
  const writeEntry = (next: SessionEntry) => {
    const previous = requireEntry();
    writeSessionEntry(database, sessionKey, next, {
      canonicalPreviousEntry: previous,
      previousEntry: previous,
    });
  };
  const lifecycle = (
    sessionId: string,
    expectedState: SessionTranscriptTurnExpectedState,
    patch: SessionTranscriptTurnLifecyclePatch & Pick<SessionEntry, "activeWriterRunId">,
    expectedLifecycleRevision?: string | null,
    defer = false,
  ) => {
    const entry = requireEntry();
    if (
      !sessionMatchesExpectedTranscriptTurn(
        { entry },
        {
          expectedSessionId: sessionId,
          expectedSessionState: expectedState,
          expectedWriterRunId: expectedState.expectedWriterRunId,
          expectedLifecycleRevision,
        },
      )
    ) {
      throw new SessionActorStaleStateError(
        "Session actor lifecycle changed before its durable phase",
      );
    }
    const next = {
      ...entry,
      ...patch,
      ...(patch.restartRecoveryTerminalRunIds
        ? {
            restartRecoveryTerminalRunIds: mergeRestartRecoveryTerminalRunIds(
              entry.restartRecoveryTerminalRunIds,
              patch.restartRecoveryTerminalRunIds,
            ),
          }
        : {}),
    };
    if (!isDeepStrictEqual(entry, next)) {
      if (defer) {
        entryUpdate = next;
      } else {
        writeEntry(next);
      }
    }
  };
  const turn = (input: SessionTurnPlan) => {
    if (
      input.sessionKey !== sessionKey ||
      input.options.expectedSessionId !==
        (state.hot.entry?.sessionId ?? input.options.initialSessionEntry?.sessionId)
    ) {
      throw new Error("Session actor turn changed its captured target");
    }
    assertCanonicalSessionKeyWrite(sessionKey, input.agentId);
    const committed = applySessionTurn(
      input,
      context,
      (_database, candidate) => candidate,
      incarnation,
    );
    if (committed.result.rejectedReason || committed.result.predicateSkipped) {
      throw new SessionActorStaleStateError("Session actor turn was refused by its current owner");
    }
    return committed;
  };
  let result: SessionActorPhaseResults[SessionActorPhase];
  let pendingInputMutationReceipt: PendingInputMutationReceipt | undefined;
  switch (command.type) {
    case "session.actor.acceptInput": {
      const { pending, expectedState, lifecycle: patch } = command.input;
      if (
        pending &&
        (pending.sessionKey !== sessionKey || pending.sessionId !== requireEntry().sessionId)
      ) {
        throw new Error("Session actor input changed its captured target");
      }
      if (command.input.turn && command.input.append) {
        throw new Error("Session actor input must use one append contract");
      }
      const recovery = command.input.recovery;
      if (recovery) {
        const entry = requireEntry();
        if (
          (entry.restartRecoveryDeliveryRunId ?? entry.activeWriterRunId) !==
            recovery.expectedRunId ||
          readSessionSourceValidation(database, recovery.sources, incarnation).refusedSource
        ) {
          throw new Error("Session actor recovery lost its source or run");
        }
        const claim = recovery.harnessCompletion;
        if (
          claim &&
          (claim.requesterSessionKey !== sessionKey ||
            claim.requesterAgentId !== database.agentId ||
            claim.sessionId !== entry.sessionId ||
            claim.lifecycleRevision !== entry.lifecycleRevision ||
            !readHarnessCompletionSourceInDatabase(database, claim).validInput)
        ) {
          throw new Error("Session actor recovery input no longer matches its source");
        }
        context.admit("transaction", { kind: "session-actor-recovery", recovery });
      }
      if (pending) {
        pendingInputMutationReceipt = mutatePendingInput(pending, context, () => {});
      }
      const input = command.input.turn;
      if (
        input?.options.initialSessionEntry &&
        Object.values(expectedState).some((value) => value !== undefined)
      ) {
        throw new Error("Session actor initialization cannot expect an existing lifecycle");
      }
      if (!input && pending) {
        lifecycle(pending.sessionId, expectedState, patch);
      }
      result = {
        inputId: pending && (pending.expected.existing?.input_id ?? pending.inputId),
        ...(input
          ? {
              turn: turn({
                ...input,
                options: {
                  ...input.options,
                  ...(!input.options.initialSessionEntry
                    ? { expectedSessionState: expectedState }
                    : {}),
                  sessionLifecyclePatch: { ...input.options.sessionLifecyclePatch, ...patch },
                },
              }),
            }
          : {}),
        ...(command.input.append
          ? { append: applySessionActorAppend(command.input.append, state, context) }
          : {}),
        adoption: pending && {
          existing: pending.expected.existing,
          previous: pending.expected.previous,
          committed: pending.expected.committed,
        },
        pendingInputReceipt: pendingInputMutationReceipt,
      };
      break;
    }
    case "session.actor.adoptRun": {
      const patch = {
        ...command.input.lifecycle,
        ...(command.input.runId !== undefined ? { activeWriterRunId: command.input.runId } : {}),
      };
      const input = command.input.turn;
      if (input) {
        if (input.options.expectedSessionId !== command.input.sessionId) {
          throw new Error("Session actor adoption changed its captured session");
        }
        result = turn({
          ...input,
          options: {
            ...input.options,
            expectedSessionState: command.input.expectedState,
            sessionLifecyclePatch: { ...input.options.sessionLifecyclePatch, ...patch },
          },
        });
      } else {
        lifecycle(command.input.sessionId, command.input.expectedState, patch);
      }
      break;
    }
    case "session.actor.deliveryPending": {
      const input = command.input;
      if (input.claim) {
        const entry = state.hot.entry;
        if (!entry) {
          result = { disposition: "stale" };
          break;
        }
        const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(entry, input.claim);
        if (disposition === "startable") {
          entryUpdate = {
            ...entry,
            restartRecoveryDeliveryReceiptState: "terminal-pending",
            restartRecoveryDeliveryToolCallId: input.claim.toolCallId,
            updatedAt: input.updatedAt,
          };
          result = { disposition: "started" };
        } else {
          result = { disposition };
        }
      } else {
        lifecycle(input.sessionId, input.expectedState, input.lifecycle, undefined, true);
      }
      break;
    }
    case "session.actor.appendToolResult":
      result = command.input.append
        ? applySessionActorAppend(command.input.append, state, context)
        : turn(command.input.turn);
      break;
    case "session.actor.appendTranscriptEvent": {
      const input = command.input;
      if (input.append) {
        result = applySessionActorAppend(input.append, state, context);
        break;
      }
      if ((requireEntry().lifecycleRevision ?? null) !== input.lifecycleRevision) {
        throw new Error("Session actor transcript lifecycle changed before append");
      }
      const validation = readSessionSourceValidation(database, input.ownerSources, incarnation);
      if (validation.refusedSource) {
        throw new Error("Session actor transcript source changed before append");
      }
      const scope = {
        agentId: database.agentId,
        path: database.path,
        sessionKey,
        sessionId: input.sessionId,
      };
      const committed = applySessionTranscriptEvent(
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
      result = { projectionNeedsReconcile: committed.projectionNeedsReconcile };
      break;
    }
    case "session.actor.completeTurn": {
      const { pendingFinalDelivery, turn: input, bookkeeping } = command.input;
      if (bookkeeping) {
        if (requireEntry().activeWriterRunId !== bookkeeping.writerRunId) {
          throw new SessionActorStaleStateError(
            "Session actor completion writer changed before its durable phase",
          );
        }
        lifecycle(
          bookkeeping.sessionId,
          bookkeeping.expectedState,
          { ...bookkeeping.lifecycle, ...(pendingFinalDelivery ? { pendingFinalDelivery } : {}) },
          bookkeeping.lifecycleRevision,
          true,
        );
        result = { kind: "bookkeeping" };
      } else {
        result = turn(
          pendingFinalDelivery
            ? {
                ...input,
                options: {
                  ...input.options,
                  sessionLifecyclePatch: {
                    ...input.options.sessionLifecyclePatch,
                    pendingFinalDelivery,
                  },
                },
              }
            : input,
        );
        const terminal = input.options.messages.length
          ? undefined
          : input.options.sessionLifecyclePatch;
        if (terminal || pendingFinalDelivery) {
          const entry = requireEntry();
          const next = {
            ...entry,
            ...terminal,
            ...(terminal?.restartRecoveryTerminalRunIds
              ? {
                  restartRecoveryTerminalRunIds: mergeRestartRecoveryTerminalRunIds(
                    entry.restartRecoveryTerminalRunIds,
                    terminal.restartRecoveryTerminalRunIds,
                  ),
                }
              : {}),
            ...(pendingFinalDelivery ? { pendingFinalDelivery } : {}),
          };
          if (!isDeepStrictEqual(entry, next)) {
            entryUpdate = next;
          }
        }
      }
      const completion = command.input.completion;
      if (completion) {
        if (
          completion.sessionKey !== sessionKey ||
          completion.sessionId !== requireEntry().sessionId
        ) {
          throw new Error("Session actor completion changed its captured target");
        }
        pendingInputMutationReceipt = mutatePendingInput(completion, context, () => {});
      }
      break;
    }
    case "session.actor.deliverySettled": {
      const input = command.input;
      const entry = state.hot.entry;
      if (!entry) {
        result = input.restart ? { disposition: "stale" } : { state: "stale", wakeRecovery: false };
        break;
      }
      if (input.restart) {
        const { claim, outcome, updatedAt } = input.restart;
        const patch = projectRestartRecoveryDeliverySettlement(entry, claim, outcome, updatedAt);
        if (patch) {
          entryUpdate = { ...entry, ...patch };
          result = { disposition: outcome === "confirmed" ? "recorded" : "cleared" };
        } else if (!hasActiveRestartRecoveryDeliveryClaim(entry, claim)) {
          result = { disposition: "stale" };
        } else if (
          hasExactRestartRecoveryDeliveryClaim(entry, claim) &&
          entry.restartRecoveryDeliveryReceiptState === "delivered-terminal"
        ) {
          result = { disposition: outcome === "confirmed" ? "recorded" : "stale" };
        } else if (
          outcome === "not-sent" &&
          !entry.restartRecoveryDeliveryReceiptState &&
          !entry.restartRecoveryDeliveryToolCallId
        ) {
          result = { disposition: "cleared" };
        } else {
          throw new Error(
            outcome === "confirmed"
              ? "failed to persist terminal delivery completion"
              : "failed to clear terminal delivery intent",
          );
        }
        break;
      }
      const settlement = projectPendingFinalDeliverySettlement(
        entry,
        input.settlement,
        input.evidence,
      );
      if (settlement.patch) {
        entryUpdate = { ...entry, ...settlement.patch };
      }
      result = { state: settlement.state, wakeRecovery: settlement.wakeRecovery };
      break;
    }
    case "session.actor.patch":
      break;
  }
  const reducers: SessionActorReducerOutcome[] = [];
  if (command.input.reducers?.length) {
    let entry = entryUpdate ?? requireEntry();
    for (const [index, reducer] of command.input.reducers.entries()) {
      let next: SessionEntry;
      try {
        next = reduceSessionActorEntry(entry, [reducer]);
      } catch (error) {
        if (reducer.kind !== "usage") {
          throw error;
        }
        reducers.push({
          index,
          kind: reducer.kind,
          changed: false,
          failure:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: "Error", message: "Session usage reduction failed" },
        });
        continue;
      }
      reducers.push({ index, kind: reducer.kind, changed: !isDeepStrictEqual(entry, next) });
      entry = next;
    }
    if (reducers.some(({ changed }) => changed)) {
      entryUpdate = entry;
    }
  }
  if (entryUpdate) {
    writeEntry(entryUpdate);
  }
  const committedTurn =
    result && "kind" in result && result.kind === "session-turn"
      ? result
      : result && "turn" in result
        ? result.turn
        : undefined;
  if (committedTurn) {
    committedTurn.result.sessionEntry = structuredClone(requireEntry());
  }
  return { value: result, pendingInputMutationReceipt, reducers };
}
