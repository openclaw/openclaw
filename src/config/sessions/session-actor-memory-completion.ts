import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { getRestartRecoveryTerminalDeliveryEvidence } from "./restart-recovery-state.js";
import type { SessionActorMemoryCompletionReads } from "./session-actor-memory-completion-contract.js";
import { selectSessionActorMemoryAdmittedWindow } from "./session-actor-memory-history-context.js";
import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemoryHistoryScope } from "./session-actor-memory-history-projection.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import { createHarnessCompletionInputPredicate } from "./session-harness-completion-input.js";

type CompletionRead = SessionActorMemoryCompletionReads["session.completion.read"];

/** Entry, submitted identity and active input evidence come from the same owned state. */
export function readSessionActorMemoryCompletion(
  state: SessionActorMemoryState,
  input: CompletionRead["input"],
  scope: SessionActorMemoryHistoryScope,
): CompletionRead["output"] {
  const entry = state.hot.entry;
  const inputKey = `${input.sourceRunId}:user`;
  const hasSubmittedInput =
    state.pendingInputs.has(inputKey) ||
    state.hot.transcript.idempotency.some(({ key }) => key === inputKey);
  const claim =
    input.claim ??
    (entry?.restartRecoveryHarnessCompletion?.sourceRunId === input.sourceRunId
      ? entry.restartRecoveryHarnessCompletion
      : getRestartRecoveryTerminalDeliveryEvidence(entry, input.sourceRunId)?.harnessCompletion);
  if (
    !entry ||
    !claim ||
    (input.mode !== "committed" && entry.restartRecoveryDeliveryRunId === claim.sourceRunId)
  ) {
    return { entry, hasSubmittedInput, validInput: true };
  }
  const window = selectSessionActorMemoryAdmittedWindow(state, scope, input.admission);
  const navigation = createSessionActorMemoryHistoryNavigation(window);
  const start = navigation.active.findIndex(({ event }) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    return message?.idempotencyKey === inputKey;
  });
  // Retained display history before a reset cannot grant execution authority.
  if (start < 0 || start < (navigation.boundaryActivePosition ?? 0)) {
    return { entry, hasSubmittedInput, validInput: false, version: state.hot.transcript.version };
  }
  const accept = createHarnessCompletionInputPredicate({
    claim,
    entry,
    operationalRunId: entry.restartRecoveryDeliveryRunId,
  });
  const users = navigation.active.slice(start).flatMap(({ event }) => {
    const message = asOptionalRecord(asOptionalRecord(event)?.message);
    return message?.role === "user" ? [message] : [];
  });
  return {
    entry,
    hasSubmittedInput,
    validInput: users.length > 0 && users.every(accept),
    version: state.hot.transcript.version,
  };
}
