import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { applySessionGoalOperation } from "./goals-operation-policy.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { createSessionActorMemoryGoals } from "./session-actor-memory-goals.js";
import { createSessionActorMemoryMessages } from "./session-actor-memory-messages.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import type { SessionActorMemoryTurnReads } from "./session-actor-memory-turn-contract.js";
import { createSessionTranscriptTurnKernel } from "./session-turn.kernel.js";
import type { SessionTurnPlan } from "./session-turn.types.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";

/** Canonical replay bytes stay with the selected actor when the hot replica cannot prepare. */
export function prepareSessionActorMemoryTurn(
  context: SessionActorMemoryStorageContext,
  input: SessionTurnPlan,
): SessionActorMemoryTurnReads["session.turn.prepare"]["output"] {
  const { state } = context;
  const scope = {
    agentId: context.agentId,
    path: context.path,
    sessionKey: input.sessionKey,
    sessionId: input.options.expectedSessionId,
  };
  if (input.agentId !== context.agentId || input.sessionKey !== state.hot.target.sessionKey) {
    throw new Error("Turn preparation does not target this session actor");
  }
  const kernel = createSessionTranscriptTurnKernel(scope, input.options);
  const selected = state.hot.entry ? { entry: state.hot.entry } : undefined;
  const ownerSourceValidation = input.ownerSources?.length
    ? context.validateSources(input.ownerSources)
    : undefined;
  if (ownerSourceValidation?.refusedSource) {
    return { refusedOwnerSource: ownerSourceValidation.refusedSource };
  }
  const goals = createSessionActorMemoryGoals(context);
  const mutation = input.options.sessionTurnMutation;
  goals.assertRouting(mutation?.routingPredicate);
  const replay = mutation ? goals.readReceipt(scope.sessionId, mutation.operation) : undefined;
  const expectedEntry = kernel.resolveExpectedEntry(selected);
  const result =
    replay && selected?.entry.sessionId === scope.sessionId
      ? {
          appendedMessages: [],
          sessionEntry: selected.entry,
          sessionFile: input.options.sessionFile,
          sessionTurnMutationResult: { result: replay, replayed: true },
        }
      : !expectedEntry
        ? {
            appendedMessages: [],
            rejectedReason: "session-rebound" as const,
            sessionEntry: selected?.entry,
            sessionFile: input.options.sessionFile,
          }
        : undefined;
  const events = createSessionActorMemoryEvents(context);
  const messages = createSessionActorMemoryMessages(context, events);
  return {
    ownerSourceValidation,
    result,
    messages: result
      ? []
      : input.options.messages.map((append) => {
          const key = readMessageIdempotencyKey(append.message);
          const existing = messages.findByKey(append);
          const messageId = existing?.id;
          // Preparation selects canonical bytes; the append owner checks live custody at commit.
          const pending = Boolean(
            isRecord(append.message) &&
            append.message.role === "user" &&
            key &&
            (state.pendingInputs.has(key) || input.custody?.idempotencyKey === key),
          );
          return {
            pending,
            existing:
              existing && typeof messageId === "string"
                ? { messageId, message: existing.message }
                : undefined,
          };
        }),
    coldArchive: undefined,
    version: events.version(),
    goalId:
      mutation && !result && expectedEntry && input.options.messages.length
        ? applySessionGoalOperation(expectedEntry, mutation.operation, Date.now())?.id
        : undefined,
  };
}
