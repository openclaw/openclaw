// Process-global session-goal change emitter.
//
// Mirrors the QuestionManager emitter pattern: core goal-store writes call
// `emitGoalUpdated` after every successful mutation, and the gateway binds a
// broadcaster at startup so a single `goal.updated` event reaches Control UI and
// channels for EVERY mutation path — `/goal` commands, the model goal tools, and
// the autonomous goal driver — without each call site knowing about the gateway.
import type { SessionGoal, SessionGoalStatus } from "./types.js";

/** UI-facing goal snapshot broadcast on `goal.updated`. */
export type GoalUpdatedEvent = {
  sessionKey: string;
  /** Current status, or null when the goal was cleared/removed. */
  status: SessionGoalStatus | null;
  /** Objective text, or null when cleared. */
  objective: string | null;
  tokensUsed: number | null;
  tokenBudget: number | null;
  /** Origin of the change: a host/agent mutation, or an autonomous driver transition. */
  source: "host" | "driver";
};

type GoalUpdatedEmitter = (event: GoalUpdatedEvent) => void;

let emitter: GoalUpdatedEmitter | null = null;

/** Binds (or clears with null) the global goal-updated emitter. Gateway-only. */
export function setGoalUpdatedEmitter(fn: GoalUpdatedEmitter | null): void {
  emitter = fn;
}

/** Emits a goal-updated event if an emitter is bound; a no-op otherwise. */
export function emitGoalUpdated(event: GoalUpdatedEvent): void {
  if (!emitter) {
    return;
  }
  try {
    emitter(event);
  } catch {
    // A broadcast failure must never break a goal-store write.
  }
}

/** Builds the event payload from a durable goal (or a cleared goal). */
export function goalToUpdatedEvent(
  sessionKey: string,
  goal: SessionGoal | undefined,
  source: "host" | "driver",
): GoalUpdatedEvent {
  if (!goal) {
    return {
      sessionKey,
      status: null,
      objective: null,
      tokensUsed: null,
      tokenBudget: null,
      source,
    };
  }
  return {
    sessionKey,
    status: goal.status,
    objective: goal.objective,
    tokensUsed: goal.tokensUsed,
    tokenBudget: goal.tokenBudget ?? null,
    source,
  };
}
