import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { applySessionActorAppend } from "./session-actor-append.worker.js";
import type { SessionActorStoredState } from "./session-actor-hydration.types.js";
import {
  applySessionActorPhaseWithBackend,
  type SessionActorMutation,
} from "./session-actor-phase.js";
import { readHarnessCompletionSourceInDatabase } from "./session-harness-completion-source.kernel.js";
import { applySessionTranscriptEvent } from "./session-message-rewrite.worker.js";
import { mutatePendingInput } from "./session-pending-input-operations.kernel.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import { applySessionTurn } from "./session-turn.worker.js";

export { SessionActorStaleStateError } from "./session-actor-phase.js";

/** The actor lends one transaction; nested kernels retain admission without opening savepoints. */
export function applySessionActorPhase(
  command: SessionActorMutation,
  state: SessionActorStoredState,
  context: AgentWorkerOperationContext,
) {
  const database = context.open();
  const hot = state.hot;
  const sessionKey = hot.target.sessionKey;
  const incarnation =
    hot.target.database.kind !== "file" ? hot.target.database.incarnation : undefined;
  return applySessionActorPhaseWithBackend(command, hot, {
    agentId: database.agentId,
    writeEntry(next) {
      const previous = hot.entry;
      if (!previous) {
        throw new Error("Session actor requires an existing session");
      }
      writeSessionEntry(database, sessionKey, next, {
        canonicalPreviousEntry: previous,
        previousEntry: previous,
      });
    },
    turn: (input) =>
      applySessionTurn(input, context, (_database, candidate) => candidate, incarnation),
    append(input) {
      const result = applySessionActorAppend(input, state, context);
      // Initialization may rehydrate storage; keep the phase's shared hot object current.
      if (state.hot !== hot) {
        Object.assign(hot, state.hot);
        state.hot = hot;
      }
      return result;
    },
    appendEvent(input) {
      const scope = {
        agentId: database.agentId,
        path: database.path,
        sessionKey,
        sessionId: input.sessionId,
      };
      return applySessionTranscriptEvent(
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
    },
    validateSources: (sources) => readSessionSourceValidation(database, sources, incarnation),
    validateRecoveryInput: (claim) =>
      readHarnessCompletionSourceInDatabase(database, claim).validInput,
    mutatePendingInput: (input) => mutatePendingInput(input, context, () => {}),
    admit: (stage, publication) => context.admit(stage, publication),
  });
}
