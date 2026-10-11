import { isDeepStrictEqual } from "node:util";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import {
  hasActiveRestartRecoveryDeliveryClaim,
  hasExactRestartRecoveryDeliveryClaim,
  projectRestartRecoveryDeliverySettlement,
  resolveRestartRecoveryTerminalDeliveryDisposition,
} from "./restart-recovery-receipt-state.js";
import { mergeRestartRecoveryTerminalRunIds } from "./restart-recovery-state.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type {
  SessionActorAppend,
  SessionActorAppendCommitted,
  SessionActorHotState,
  SessionActorOperations,
  SessionActorPhaseInputs,
  SessionActorPhase,
  SessionActorPhaseResults,
  SessionActorReducerOutcome,
} from "./session-actor-contract.js";
import { reduceSessionActorEntry } from "./session-actor-reducers.js";
import { projectPendingFinalDeliverySettlement } from "./session-pending-final-settlement.js";
import type {
  PendingInputMutation,
  PendingInputMutationReceipt,
} from "./session-pending-input-operations.types.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import type {
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import { sessionMatchesExpectedTranscriptTurn } from "./session-transcript-turn-state.js";
import type { SessionTurnCommitted, SessionTurnPlan } from "./session-turn.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionActorMutation = Exclude<
  SqliteWorkerCommand<SessionActorOperations>,
  { type: "session.actor.read" }
>;

/** Mutations synchronously update the supplied hot state before returning. */
export type SessionActorPhaseBackend = {
  agentId: string;
  writeEntry(next: SessionEntry): void;
  turn(input: SessionTurnPlan): SessionTurnCommitted;
  append(input: SessionActorAppend): SessionActorAppendCommitted;
  appendEvent(
    input: Extract<SessionActorPhaseInputs["appendTranscriptEvent"], { eventJson: string }>,
  ): { projectionNeedsReconcile?: boolean };
  validateSources(sources: SessionSourcePredicate[] | undefined): SessionSourceValidation;
  validateRecoveryInput(claim: HarnessCompletionRecovery): boolean;
  mutatePendingInput(input: PendingInputMutation): PendingInputMutationReceipt;
  admit(stage: "transaction" | "commit", publication?: unknown): void;
};

export class SessionActorStaleStateError extends Error {}

/** Shared phase semantics run against the backend selected when the actor is acquired. */
export function applySessionActorPhaseWithBackend(
  command: SessionActorMutation,
  hot: SessionActorHotState,
  backend: SessionActorPhaseBackend,
) {
  const sessionKey = hot.target.sessionKey;
  let entryUpdate: SessionEntry | undefined;
  const requireEntry = () => {
    const entry = hot.entry;
    if (!entry) {
      throw new Error("Session actor requires an existing session");
    }
    return entry;
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
        backend.writeEntry(next);
      }
    }
  };
  const turn = (input: SessionTurnPlan) => {
    if (
      input.sessionKey !== sessionKey ||
      input.agentId !== backend.agentId ||
      input.options.expectedSessionId !==
        (hot.entry?.sessionId ?? input.options.initialSessionEntry?.sessionId)
    ) {
      throw new Error("Session actor turn changed its captured target");
    }
    const committed = backend.turn(input);
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
          backend.validateSources(recovery.sources).refusedSource
        ) {
          throw new Error("Session actor recovery lost its source or run");
        }
        const claim = recovery.harnessCompletion;
        if (
          claim &&
          (claim.requesterSessionKey !== sessionKey ||
            claim.requesterAgentId !== backend.agentId ||
            claim.sessionId !== entry.sessionId ||
            claim.lifecycleRevision !== entry.lifecycleRevision ||
            !backend.validateRecoveryInput(claim))
        ) {
          throw new Error("Session actor recovery input no longer matches its source");
        }
        backend.admit("transaction", { kind: "session-actor-recovery", recovery });
      }
      if (pending) {
        pendingInputMutationReceipt = backend.mutatePendingInput(pending);
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
        ...(command.input.append ? { append: backend.append(command.input.append) } : {}),
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
        const entry = hot.entry;
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
        ? backend.append(command.input.append)
        : turn(command.input.turn);
      break;
    case "session.actor.appendTranscriptEvent": {
      const input = command.input;
      if (input.append) {
        result = backend.append(input.append);
        break;
      }
      if ((requireEntry().lifecycleRevision ?? null) !== input.lifecycleRevision) {
        throw new Error("Session actor transcript lifecycle changed before append");
      }
      const validation = backend.validateSources(input.ownerSources);
      if (validation.refusedSource) {
        throw new Error("Session actor transcript source changed before append");
      }
      const committed = backend.appendEvent(input);
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
        pendingInputMutationReceipt = backend.mutatePendingInput(completion);
      }
      break;
    }
    case "session.actor.deliverySettled": {
      const input = command.input;
      const entry = hot.entry;
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
    backend.writeEntry(entryUpdate);
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
