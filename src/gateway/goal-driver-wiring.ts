import type { GoalDriverLogger } from "../agents/goal-driver/driver.js";
/**
 * Gateway wiring for the autonomous goal continuation driver.
 *
 * Binds {@link createGoalDriverService} to the live gateway: it re-arms every
 * persisted `active` goal on startup, classifies each completed turn as a driver
 * continuation vs a real inbound turn (for the no-progress ceiling reset), and
 * broadcasts driver-initiated status changes as `goal.updated` events.
 *
 * Returns `undefined` when `tools.experimental.goalDriver.enabled` is off so the
 * gateway wires nothing and the turn-completed seam is a zero-cost null-check.
 */
import {
  createGoalDriverService,
  type GoalDriverStatusChange,
} from "../agents/goal-driver/goal-driver-service.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { QueuedChatTurnMap } from "./chat-queued-turns.js";

/** Wraps a value as a log-meta record without losing structured fields. */
function asMeta(obj: unknown): Record<string, unknown> {
  return obj !== null && typeof obj === "object"
    ? (obj as Record<string, unknown>)
    : { value: obj };
}

/**
 * Adapts the gateway's `(message, meta)` SubsystemLogger to the driver's
 * `(obj, msg)` logger shape so structured driver diagnostics reach the same sink.
 */
function adaptLogger(log: SubsystemLogger): GoalDriverLogger {
  return {
    debug: (obj, msg) => log.debug(msg ?? "goal-driver", asMeta(obj)),
    info: (obj, msg) => log.info(msg ?? "goal-driver", asMeta(obj)),
    warn: (obj, msg) => log.warn(msg ?? "goal-driver", asMeta(obj)),
  };
}

/** Payload broadcast to Control UI / channels on a goal status/objective change. */
export type GoalUpdatedEventPayload = GoalDriverStatusChange & {
  /** Origin of the change; "driver" for autonomous transitions (auto-pause). */
  source: "driver";
};

export type GoalDriverWiring = {
  /**
   * Signal that a turn completed for a session. The wiring classifies whether
   * that turn was a driver-fired continuation (so the ceiling counter is NOT
   * reset) or a real inbound turn (which resets it), then arms the next debounce.
   */
  onTurnCompleted: (sessionKey: string) => void;
  /** Re-arm all persisted active goals (idempotent; safe to call repeatedly). */
  rearm: () => void;
  /** Cancel every pending timer. */
  stop: () => void;
};

export function startGoalDriverWiring(params: {
  config: OpenClawConfig;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatQueuedTurns: QueuedChatTurnMap;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  log?: SubsystemLogger;
}): GoalDriverWiring | undefined {
  // Sessions the driver has fired a continuation for but whose continued turn
  // has not yet completed. Consulted once per turn-end to classify the turn.
  const firedSessions = new Set<string>();

  const service = createGoalDriverService({
    config: params.config,
    chatAbortControllers: params.chatAbortControllers,
    chatQueuedTurns: params.chatQueuedTurns,
    ...(params.log ? { log: adaptLogger(params.log) } : {}),
    onGoalStatusChange: (change) => {
      const payload: GoalUpdatedEventPayload = { ...change, source: "driver" };
      params.broadcast("goal.updated", payload, { dropIfSlow: true });
    },
    onEvent: (evt) => {
      if (evt.kind === "fired") {
        firedSessions.add(evt.sessionKey);
      }
    },
  });
  if (!service) {
    return undefined;
  }

  // Recover after a restart: any session still carrying an active goal re-arms.
  service.rearmPersistedActiveGoals();

  return {
    onTurnCompleted: (sessionKey) => {
      const turnWasGoalContinuation = firedSessions.delete(sessionKey);
      service.onTurnCompleted({ sessionKey, turnWasGoalContinuation });
    },
    rearm: () => service.rearmPersistedActiveGoals(),
    stop: () => service.stop(),
  };
}
