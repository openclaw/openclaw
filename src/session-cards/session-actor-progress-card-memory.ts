import type { SessionActorMemoryState } from "../config/sessions/session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "../config/sessions/session-actor-memory-storage-context.js";
import { ProgressCardInputError } from "./progress-card-input.js";
import { normalizeProgressCardWrite } from "./progress-card-values.js";
import { progressWorkCommandForIntent } from "./progress-card-work-intent.js";
import {
  assertProgressWorkFence,
  presentSessionProgress,
  reconcileSessionProgress,
} from "./progress-card-work.js";
import type { SessionActorProgressCardCommand } from "./session-actor-progress-card-contract.js";

export function readSessionActorProgressCard(
  context: SessionActorMemoryStorageContext,
  sessionKey: string,
) {
  return presentSessionProgress(sessionKey, context.get(sessionKey)?.progressCard);
}

export function clearSessionActorProgressCardForReset(
  state: SessionActorMemoryState,
  retireWork = true,
): boolean {
  if (!state.progressCard) {
    return false;
  }
  const work = state.progressCard.work;
  state.progressCard = {
    revision: state.progressCard.revision + 1,
    updatedAt: Date.now(),
    ...(work
      ? {
          work: retireWork
            ? { generation: work.generation, revision: work.revision + 1, record: null }
            : work,
        }
      : {}),
  };
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
  const managed = command.input.managedWork;
  const workCommand = managed
    ? progressWorkCommandForIntent(managed, managed.intent, command.input.steps)
    : command.input.workCommand;
  if (managed || workCommand) {
    const owner = (managed ?? workCommand)!.owner;
    const entry = state.hot.entry;
    if (
      owner.agentId !== context.agentId ||
      owner.sessionKey !== sessionKey ||
      owner.sessionId !== entry?.sessionId ||
      owner.lifecycleRevision !== (entry?.lifecycleRevision ?? null) ||
      entry?.archivedAt !== undefined
    ) {
      throw new ProgressCardInputError("Work owner incarnation is no longer current");
    }
  }
  if (workCommand) {
    state.progressCard = reconcileSessionProgress(
      state.progressCard,
      { ...command.input, workCommand },
      Date.now(),
    );
    return {
      card: presentSessionProgress(sessionKey, state.progressCard),
      work: state.progressCard.work,
    };
  }
  if (managed) {
    assertProgressWorkFence(state.progressCard?.work, managed.expected);
  }
  const input = normalizeProgressCardWrite(command.input);
  const current = state.progressCard;
  if (!input.markdown && !input.steps) {
    if (
      input.expectedRevision !== undefined &&
      (current?.revision !== input.expectedRevision || !presentSessionProgress(sessionKey, current))
    ) {
      return { card: presentSessionProgress(sessionKey, current) };
    }
    clearSessionActorProgressCardForReset(state, false);
    return managed ? { card: null, work: state.progressCard?.work } : { cleared: true as const };
  }
  state.progressCard = {
    ...(current?.work ? { work: current.work } : {}),
    revision: (current?.revision ?? 0) + 1,
    updatedAt: Date.now(),
    ...(input.markdown ? { markdown: input.markdown } : {}),
    ...(input.steps ? { steps: structuredClone(input.steps) } : {}),
  };
  return {
    card: presentSessionProgress(sessionKey, state.progressCard),
    ...(managed ? { work: state.progressCard?.work } : {}),
  };
}
