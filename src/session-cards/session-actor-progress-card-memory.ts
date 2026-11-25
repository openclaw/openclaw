import type { SessionActorMemoryState } from "../config/sessions/session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "../config/sessions/session-actor-memory-storage-context.js";
import { normalizeProgressCardWrite } from "./progress-card-values.js";
import type {
  SessionActorMemoryProgressCard,
  SessionActorProgressCardCommand,
} from "./session-actor-progress-card-contract.js";

function presentCard(sessionKey: string, card: SessionActorMemoryProgressCard | undefined) {
  return card && (card.markdown || card.steps?.length) ? { sessionKey, ...card } : null;
}

export function readSessionActorProgressCard(
  context: SessionActorMemoryStorageContext,
  sessionKey: string,
) {
  return presentCard(sessionKey, context.get(sessionKey)?.progressCard);
}

export function clearSessionActorProgressCardForReset(state: SessionActorMemoryState): boolean {
  if (!state.progressCard) {
    return false;
  }
  state.progressCard = { revision: state.progressCard.revision + 1, updatedAt: Date.now() };
  return true;
}

export function executeSessionActorProgressCardCommand(
  context: SessionActorMemoryStorageContext,
  command: SessionActorProgressCardCommand,
) {
  const { sessionKey } = command.input;
  if (!context.get(sessionKey)?.hot.entry) {
    throw new Error(`progress-card session not found: ${sessionKey}`);
  }
  const state = context.edit(sessionKey);
  if (command.type === "progressCard.clearForReset") {
    return clearSessionActorProgressCardForReset(state);
  }
  const input = normalizeProgressCardWrite(command.input);
  const current = state.progressCard;
  if (!input.markdown && !input.steps) {
    if (
      input.expectedRevision !== undefined &&
      (current?.revision !== input.expectedRevision || !presentCard(sessionKey, current))
    ) {
      return { card: presentCard(sessionKey, current) };
    }
    clearSessionActorProgressCardForReset(state);
    return { cleared: true as const };
  }
  state.progressCard = {
    revision: (current?.revision ?? 0) + 1,
    updatedAt: Date.now(),
    ...(input.markdown ? { markdown: input.markdown } : {}),
    ...(input.steps ? { steps: structuredClone(input.steps) } : {}),
  };
  return { card: presentCard(sessionKey, state.progressCard) };
}
