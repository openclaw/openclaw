import { isDeepStrictEqual } from "node:util";
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

export type SessionActorCommittedWireOutcome<Value> = Extract<
  SessionActorOutcome<Value>,
  { kind: "committed" }
> & {
  receipt: {
    entryReference?: string;
    entryDelta?: { values: [string, unknown][]; removed: string[] };
    entryMetadataReferences?: number[];
  };
};

/** The command retains this exact preimage until native settlement completes. */
export function projectSessionActorCommittedOutcome<
  Value extends SessionActorPhaseResults[SessionActorPhase],
>(
  outcome: Extract<SessionActorOutcome<Value>, { kind: "committed" }>,
  reference: SessionActorHotState | undefined,
): SessionActorCommittedWireOutcome<Value> {
  const { receipt, value } = outcome;
  // Turn/initialization results can also expose the entry; preserve their graph aliases.
  if (
    (value &&
      (("kind" in value && value.kind === "session-turn") || ("turn" in value && value.turn))) ||
    receipt.transcript.append?.initialEntry ||
    !reference ||
    (receipt.postimage.entry !== reference.entry && (!receipt.postimage.entry || !reference.entry))
  ) {
    return outcome;
  }
  const entry = receipt.postimage.entry;
  const base = reference.entry;
  const entryDelta =
    entry && base && entry !== base
      ? {
          values: Object.entries(entry).filter(
            ([key, field]) =>
              !Object.hasOwn(base, key) || !isDeepStrictEqual(field, Reflect.get(base, key)),
          ),
          removed: Object.keys(base).filter((key) => !Object.hasOwn(entry, key)),
        }
      : undefined;
  // Metadata consumers need the same full entry, not a second wire copy.
  let entryMetadataReferences: number[] | undefined;
  const entryMetadata = receipt.entryMetadata?.map((metadata, index) => {
    const key = receipt.postimage.target.sessionKey;
    const fact = metadata.facts.get(key);
    if (fact?.kind !== "postimage" || !entry || !isDeepStrictEqual(fact.value.fullEntry, entry)) {
      return metadata;
    }
    (entryMetadataReferences ??= []).push(index);
    return {
      ...metadata,
      facts: new Map(metadata.facts).set(key, {
        ...fact,
        value: { ...fact.value, fullEntry: undefined },
      }),
    };
  });
  return {
    ...outcome,
    receipt: {
      ...receipt,
      entryReference: reference.writeToken,
      ...(entryDelta ? { entryDelta } : {}),
      entryMetadata,
      ...(entryMetadataReferences ? { entryMetadataReferences } : {}),
      postimage: { ...receipt.postimage, entry: undefined },
    },
  };
}

export function restoreSessionActorCommittedOutcome<Value>(
  outcome: SessionActorCommittedWireOutcome<Value>,
  reference: SessionActorHotState | undefined,
): Extract<SessionActorOutcome<Value>, { kind: "committed" }> {
  const { receipt } = outcome;
  if (receipt.entryReference !== undefined) {
    if (!reference || receipt.entryReference !== reference.writeToken) {
      throw new Error("Session actor receipt entry reference is unavailable");
    }
    // The replica owns this deeply frozen entry; settlement and observers only read it.
    const delta = receipt.entryDelta;
    const entry = delta
      ? { ...reference.entry!, ...Object.fromEntries(delta.values) }
      : reference.entry;
    if (delta && entry) {
      for (const key of delta.removed) {
        Reflect.deleteProperty(entry, key);
      }
    }
    receipt.postimage.entry = entry;
    for (const index of receipt.entryMetadataReferences ?? []) {
      const fact = receipt.entryMetadata![index]!.facts.get(receipt.postimage.target.sessionKey);
      if (fact?.kind === "postimage") {
        fact.value.fullEntry = entry;
      }
    }
    delete receipt.entryReference;
    delete receipt.entryDelta;
    delete receipt.entryMetadataReferences;
  }
  return outcome;
}

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
  entryMetadata?: SessionActorReceipt["entryMetadata"];
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
      entryMetadata: params.entryMetadata,
      pendingInputReceipt: turn?.custody ?? append?.value.pendingInputReceipt,
      pendingInputMutationReceipt: applied.pendingInputMutationReceipt,
      reducers: applied.reducers,
      postimage: after,
    },
  };
}
