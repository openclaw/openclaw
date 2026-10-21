import type {
  SessionActorCommandContext,
  SessionActorHotState,
  SessionActorOutcome,
  SessionActorPhase,
  SessionActorPhaseResults,
  SessionActorReceipt,
  SessionActorReducerOutcome,
} from "./session-actor-contract.js";
import type { PendingInputMutationReceipt } from "./session-pending-input-operations.types.js";

function collectAppendedEvents(
  before: SessionActorHotState,
  after: SessionActorHotState,
  payloads: ReadonlyMap<number, { event: unknown; serializedBytes: number }> | undefined,
  rewrittenGeneration = before.transcript.version.generation,
): SessionActorReceipt["transcript"]["appendedEvents"] {
  if (!payloads || rewrittenGeneration !== after.transcript.version.generation) {
    return undefined;
  }
  const beforeSeq = before.transcript.version.rawSeq ?? -1;
  const afterSeq = after.transcript.version.rawSeq ?? -1;
  if (afterSeq < beforeSeq) {
    return undefined;
  }
  const events: NonNullable<SessionActorReceipt["transcript"]["appendedEvents"]> = [];
  for (let rawSeq = beforeSeq + 1; rawSeq <= afterSeq; rawSeq += 1) {
    const payload = payloads.get(rawSeq);
    if (!payload) {
      return undefined;
    }
    events.push({
      rawSeq,
      event: structuredClone(payload.event),
      serializedBytes: payload.serializedBytes,
    });
  }
  return events;
}

/** Assemble a receipt; the backend owns capturing its postimage before publication. */
export function createSessionActorCommittedOutcome<
  Value extends SessionActorPhaseResults[SessionActorPhase],
>(params: {
  phase: SessionActorPhase;
  command: Pick<SessionActorCommandContext, "commandId" | "phaseId">;
  before: SessionActorHotState;
  after: SessionActorHotState;
  payloads?: ReadonlyMap<number, { event: unknown; serializedBytes: number }>;
  transcriptAuthority?: SessionActorReceipt["transcript"]["authorityReceipts"];
  conversationPublication?: SessionActorReceipt["conversationPublication"];
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
        appendedEvents: collectAppendedEvents(
          before,
          after,
          params.payloads,
          append?.modelPromptProjection?.after.generation,
        ),
        authorityReceipts: params.transcriptAuthority,
        append,
        projectionNeedsReconcile:
          Boolean(turn?.projectionNeedsReconcile) ||
          Boolean(append?.value.projectionNeedsReconcile) ||
          Boolean(append?.header?.projectionNeedsReconcile) ||
          Boolean(value && "projectionNeedsReconcile" in value && value.projectionNeedsReconcile),
      },
      conversationPublication: params.conversationPublication,
      pendingInputReceipt: turn?.custody ?? append?.value.pendingInputReceipt,
      pendingInputMutationReceipt: applied.pendingInputMutationReceipt,
      pendingFinalDelivery: structuredClone(after.entry?.pendingFinalDelivery),
      reducers: applied.reducers,
      postimage: after,
    },
  };
}
