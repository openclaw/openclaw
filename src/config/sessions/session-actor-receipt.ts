import type {
  SessionActorCommandContext,
  SessionActorHotState,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorPhaseResults,
  SessionActorReducerOutcome,
} from "./session-actor-contract.js";
import type { PendingInputMutationReceipt } from "./session-pending-input-operations.types.js";

/** Project the exact phase result and complete postimage into its committed receipt. */
export function createSessionActorCommittedOutcome<
  Value extends SessionActorPhaseResults[SessionActorPhase],
>(params: {
  phase: SessionActorPhase;
  command: Pick<SessionActorCommandContext, "commandId" | "phaseId">;
  before: SessionActorHotState;
  after: SessionActorHotState;
  applied: {
    value: Value;
    pendingInputMutationReceipt?: PendingInputMutationReceipt;
    reducers: SessionActorReducerOutcome[];
  };
}): Extract<SessionActorOutcome<Value>, { kind: "committed" }> {
  const { phase, command, before, after, applied } = params;
  const value: SessionActorPhaseResults[SessionActorPhase] = applied.value;
  const turn =
    value && "kind" in value && value.kind === "session-turn"
      ? value
      : value && "turn" in value
        ? value.turn
        : undefined;
  const append =
    value && "kind" in value && (value.kind === "message" || value.kind === "metadata")
      ? value
      : value && "append" in value
        ? value.append
        : undefined;
  const appended = append?.value.snapshot.ok ? append.value.snapshot.value.result : undefined;
  return {
    kind: "committed" as const,
    value: applied.value,
    receipt: {
      kind: "session-actor-committed" as const,
      commandId: command.commandId,
      phaseId: command.phaseId,
      phase,
      beforeVersion: before.version,
      afterVersion: after.version,
      transcript: {
        before: before.transcript.version,
        after: after.transcript.version,
        appendedMessages:
          turn?.result.appendedMessages ?? (appended && "messageId" in appended ? [appended] : []),
        append,
        projectionNeedsReconcile:
          Boolean(turn?.projectionNeedsReconcile) ||
          Boolean(append?.value.projectionNeedsReconcile) ||
          Boolean(append?.header?.projectionNeedsReconcile) ||
          Boolean(value && "projectionNeedsReconcile" in value && value.projectionNeedsReconcile),
      },
      pendingInputReceipt: turn?.custody ?? append?.value.pendingInputReceipt,
      pendingInputMutationReceipt: applied.pendingInputMutationReceipt,
      pendingFinalDelivery: structuredClone(after.entry?.pendingFinalDelivery),
      reducers: applied.reducers,
      postimage: structuredClone(after),
    },
  };
}
