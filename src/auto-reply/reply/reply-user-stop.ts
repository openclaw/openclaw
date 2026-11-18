import { resolveUserStoppedAt } from "../../config/sessions/terminal-status.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import type { FollowupRun } from "./queue/types.js";

/** The admitted turn's facts the claim reads; preparation's `AdmittedFollowupTurn` supplies them. */
type AdmittedStopTurn = {
  queued: Pick<FollowupRun, "abortKey" | "run">;
  session: {
    current: () => SessionEntry | undefined;
    publish: (entry: SessionEntry | undefined) => void;
  } & ({ kind: "detached" } | { kind: "session"; key: string; storePath?: string });
  sessionStore?: Record<string, SessionEntry>;
  preflightError?: Error;
  preflightFailurePayload?: unknown;
};

/**
 * Claims a user's recorded Stop for a turn admitted to run, the one place its note is consumed:
 * routes that answer, refuse, skip or steer a turn never reach it and leave the Stop recorded.
 * True only for the turn whose claim retired it, which then states it (`stateUserStop`).
 */
export async function claimUserStopForAdmittedTurn(turn: AdmittedStopTurn): Promise<boolean> {
  if (turn.preflightError || turn.preflightFailurePayload) {
    return false;
  }
  const sessionEntry = turn.session.current();
  const { abortKey } = turn.queued;
  if (!sessionEntry) {
    // Without a row, only a Stop sets the command's abort memory.
    if (!abortKey || getAbortMemory(abortKey) !== true) {
      return false;
    }
    setAbortMemory(abortKey, false);
    return true;
  }
  if (resolveUserStoppedAt(sessionEntry) === undefined) {
    return false;
  }
  const { claimUserStopInSessionRuntime, holdsUserStopOf } =
    await import("./abort-cutoff.runtime.js");
  const sessionKey = turn.session.kind === "session" ? turn.session.key : undefined;
  const claimed = await claimUserStopInSessionRuntime({
    agentId: turn.queued.run.agentId,
    sessionEntry,
    sessionKey,
    storePath: turn.session.kind === "session" ? turn.session.storePath : undefined,
  });
  if (claimed) {
    // The turn's copies drop the Stop it retired, so no later write of them restores it; a map
    // entry holding another Stop is not this turn's to clear.
    const retired = { userStoppedAt: undefined, userStoppedSessionId: undefined };
    turn.session.publish({ ...sessionEntry, ...retired });
    const stored = sessionKey ? turn.sessionStore?.[sessionKey] : undefined;
    if (sessionKey && stored && turn.sessionStore && holdsUserStopOf(stored, sessionEntry)) {
      turn.sessionStore[sessionKey] = { ...stored, ...retired };
    }
  }
  return claimed;
}
