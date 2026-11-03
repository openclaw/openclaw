import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHookRunStoppedEvent } from "../plugins/hook-run-stopped.types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { stopSkillExperienceReview } from "../skills/workshop/experience-review-default.js";
import type { SessionStopSource } from "./session-controller.stop.js";

const log = createSubsystemLogger("sessions/stop");

const EXPLICIT_RUN_STOP_SOURCES = new Set<SessionStopSource>([
  "channel-user",
  "client-session",
  "client-run",
]);

/** Stop sources that mean a user or operator stopped the run on purpose. */
type ExplicitRunStopSource = Extract<
  SessionStopSource,
  "channel-user" | "client-session" | "client-run"
>;

export function isExplicitRunStopSource(
  source: SessionStopSource,
): source is ExplicitRunStopSource {
  return EXPLICIT_RUN_STOP_SOURCES.has(source);
}

export type SessionRunStopIntent = {
  source: ExplicitRunStopSource;
  sessions: readonly { agentId?: string; sessionKey?: string; sessionId?: string }[];
  runIds: readonly string[];
};

const durableStopInvalidators = new Set<
  (intent: SessionRunStopIntent, assertCurrent: () => void) => Promise<void>
>();

/** Durable producers participate in Stop acceptance, independently of the old run lifetime. */
export function registerSessionRunStopInvalidator(
  invalidate: (intent: SessionRunStopIntent, assertCurrent: () => void) => Promise<void>,
): () => void {
  durableStopInvalidators.add(invalidate);
  return () => durableStopInvalidators.delete(invalidate);
}

/** Call after live Stop authorization and await before acknowledging cancellation. */
export async function invalidateSessionRunStopIntents(
  intent: SessionRunStopIntent,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  await Promise.all(
    [...durableStopInvalidators].map((invalidate) => invalidate(intent, () => assertCurrent?.())),
  );
  assertCurrent?.();
}

/** Exact-run Stop can outlive the RPC source it originally selected. */
export function invalidateExactSessionRunStop(
  session: { agentId?: string; sessionKey?: string; sessionId?: string },
  runId: string,
  assertCurrent: () => void,
  sessionId = session.sessionId,
): Promise<void> {
  return invalidateSessionRunStopIntents(
    { source: "client-run", sessions: [{ ...session, sessionId }], runIds: [runId] },
    assertCurrent,
  );
}

/**
 * Announces one explicit Stop of the given sessions' runs. Callers invoke it once per Stop, after
 * the Stop's live authority is confirmed and before cancellation commits, so a rejected Stop
 * announces nothing. Watchdog, restart, supersede and failure stops never call it.
 *
 * Consumers start synchronously, before the stopped runs' own completions can arrive, and can
 * never block or fail the Stop.
 */
export function notifySessionRunStopped(params: {
  source: ExplicitRunStopSource;
  sessions: Iterable<{ agentId?: string; sessionKey?: string }>;
  runIds: Iterable<string>;
}): void {
  const sessions = new Map<string, { agentId: string; sessionKey: string }>();
  for (const { agentId, sessionKey } of params.sessions) {
    if (agentId && sessionKey) {
      sessions.set(JSON.stringify([agentId, sessionKey]), { agentId, sessionKey });
    }
  }
  const event: PluginHookRunStoppedEvent = {
    source: params.source === "channel-user" ? "channel" : "client",
    sessions: [...sessions.values()],
    runIds: [...new Set([...params.runIds].map((runId) => runId.trim()).filter(Boolean))],
  };
  // Core Workshop is not a plugin yet, so it has no hook registration; it consumes the same
  // event directly until it moves to `api.on("run_stopped")`.
  stopSkillExperienceReview({ sessions: event.sessions, runIds: event.runIds });
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("run_stopped")) {
    return;
  }
  // The runner calls each handler synchronously; only its asynchronous tail is detached.
  void runner
    .runRunStopped(event, event.sessions.length === 1 ? { ...event.sessions[0] } : {})
    .catch((error: unknown) => {
      log.warn(`run_stopped hook failed: ${formatErrorMessage(error)}`);
    });
}
