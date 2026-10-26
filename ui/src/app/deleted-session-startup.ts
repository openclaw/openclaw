import type { ApplicationContext } from "./context.ts";

/** Retain first-turn display through deletion; startup still owns its outcome and recovery. */
export function readDeletedSessionStartup(
  context: Pick<ApplicationContext, "placementStartup" | "sessions">,
  sessionKey: string,
) {
  const startup = context.placementStartup.get(sessionKey);
  return startup?.initialTurn &&
    (startup.phase === "cancelled" || context.sessions.deletionState(sessionKey) === "confirmed")
    ? startup
    : null;
}
