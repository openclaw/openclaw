import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import { createSessionTranscriptTurnKernel } from "./session-turn.kernel.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import type { prepareSessionTurn } from "./session-turn.worker.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

/** Prepare fresh input from complete MAIN facts; canonical retry bodies stay with their reader. */
export function prepareSessionInputFromReplica(
  plan: SessionTurnPlan,
  hot: SessionActorHotState,
  scope: ResolvedTranscriptScope,
): ReturnType<typeof prepareSessionTurn> | undefined {
  if (
    plan.options.sessionTurnMutation ||
    hot.transcript.modelContext.kind !== "resident" ||
    hot.target.sessionKey !== plan.sessionKey
  ) {
    return undefined;
  }
  const kernel = createSessionTranscriptTurnKernel(scope, plan.options);
  if (!kernel.resolveExpectedEntry(hot.entry ? { entry: hot.entry } : undefined)) {
    return undefined;
  }
  for (const source of plan.ownerSources ?? []) {
    const identity = hot.target.database;
    const sourceIdentity =
      identity.kind === "file" ? identity.physicalIdentity : identity.incarnation;
    if (
      source.source.databaseIdentity !== sourceIdentity ||
      source.source.agentId !== scope.agentId ||
      source.source.path !== scope.path ||
      source.sessionKey !== plan.sessionKey ||
      source.conversationAlternatives ||
      Boolean(source.expected) !== Boolean(hot.entry) ||
      source.fields.some(
        (field) => !isDeepStrictEqual(source.expected?.[field], hot.entry?.[field]),
      ) ||
      (source.members &&
        !isDeepStrictEqual(
          source.members,
          hot.members.map((member) => member.identityId),
        )) ||
      (source.transcript &&
        (source.transcript.sessionId !== scope.sessionId ||
          !isDeepStrictEqual(source.transcript.version, hot.transcript.version)))
    ) {
      return undefined;
    }
  }
  const messages = [];
  for (const append of plan.options.messages) {
    if (!isRecord(append.message) || append.message.role !== "user") {
      return undefined;
    }
    const key = readMessageIdempotencyKey(append.message);
    // A retry needs canonical stored bytes, not just membership in the hot index.
    if (
      append.idempotencyLookup === "scan-assistant" ||
      (key && hot.transcript.idempotency.some((row) => row.key === key))
    ) {
      return undefined;
    }
    const pending = key ? hot.pendingInputs.find((row) => row.idempotency_key === key) : undefined;
    if (!pending && key === plan.custody?.idempotencyKey) {
      return undefined;
    }
    if (
      pending &&
      (!plan.custody ||
        pending.input_id !== plan.custody.inputId ||
        pending.state !== "queued" ||
        pending.consumed_event_id !== null)
    ) {
      return undefined;
    }
    messages.push({ pending: Boolean(pending), existing: undefined });
  }
  return {
    ownerSourceValidation: plan.ownerSources?.length ? { conversationMatches: [] } : undefined,
    result: undefined,
    messages,
    coldArchive: undefined,
    version: hot.transcript.version,
    goalId: undefined,
  };
}
