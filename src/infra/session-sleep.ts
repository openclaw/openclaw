/** Process-local, restart-ephemeral sleep timers keyed by canonical session. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type SessionSleepEntry = {
  timer: ReturnType<typeof setTimeout>;
  token: symbol;
};

export type ScheduleSessionSleepParams = {
  sessionKey: string;
  delayMs: number;
  onWake: () => Promise<void> | void;
  onError?: (error: unknown) => void;
};

const SESSION_SLEEP_STATE_KEY = Symbol.for("openclaw.sessionSleepRuntimeState");

function getSessionSleeps(): Map<string, SessionSleepEntry> {
  return resolveGlobalSingleton(SESSION_SLEEP_STATE_KEY, () => new Map());
}

/** Replaces any pending sleep for the session and arms a transient timer. */
export function scheduleSessionSleep(params: ScheduleSessionSleepParams): void {
  cancelSessionSleep(params.sessionKey);
  const sleepsBySessionKey = getSessionSleeps();
  const token = Symbol(params.sessionKey);
  const timer = setTimeout(() => {
    const current = sleepsBySessionKey.get(params.sessionKey);
    if (current?.token !== token) {
      return;
    }
    sleepsBySessionKey.delete(params.sessionKey);
    Promise.resolve()
      .then(params.onWake)
      .catch((error) => params.onError?.(error));
  }, params.delayMs);
  timer.unref?.();
  sleepsBySessionKey.set(params.sessionKey, { timer, token });
}

/** Cancels a pending sleep before its wake begins. */
export function cancelSessionSleep(sessionKey: string): boolean {
  const sleepsBySessionKey = getSessionSleeps();
  const entry = sleepsBySessionKey.get(sessionKey);
  if (!entry) {
    return false;
  }
  clearTimeout(entry.timer);
  sleepsBySessionKey.delete(sessionKey);
  return true;
}

/** Test/shutdown helper; process restart also discards the module state. */
export function clearSessionSleeps(): void {
  const sleepsBySessionKey = getSessionSleeps();
  for (const entry of sleepsBySessionKey.values()) {
    clearTimeout(entry.timer);
  }
  sleepsBySessionKey.clear();
}

export function hasPendingSessionSleep(sessionKey: string): boolean {
  return getSessionSleeps().has(sessionKey);
}
