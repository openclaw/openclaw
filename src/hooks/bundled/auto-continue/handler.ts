import { requestHeartbeat } from "../../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookHandler } from "../../hooks.js";

const log = createSubsystemLogger("auto-continue");

// Loop-guard: cap how often a single session may be auto-continued so a
// pathological abort -> continue -> abort cycle can never run away. State is a
// globalThis singleton so it survives bundle splitting (same pattern the
// internal-hook registry uses).
const MAX_CONTINUES = 3;
const WINDOW_MS = 30 * 60 * 1000;
const CONTINUE_HISTORY_KEY = Symbol.for("openclaw.autoContinueHistory");

function getHistory(): Map<string, number[]> {
  const g = globalThis as Record<symbol, unknown>;
  let map = g[CONTINUE_HISTORY_KEY] as Map<string, number[]> | undefined;
  if (!map) {
    map = new Map<string, number[]>();
    g[CONTINUE_HISTORY_KEY] = map;
  }
  return map;
}

function withinBudget(sessionKey: string, now: number): boolean {
  const history = getHistory();
  const recent = (history.get(sessionKey) ?? []).filter((ts) => now - ts < WINDOW_MS);
  if (recent.length >= MAX_CONTINUES) {
    history.set(sessionKey, recent);
    return false;
  }
  recent.push(now);
  history.set(sessionKey, recent);
  return true;
}

const handler: HookHandler = async (event) => {
  try {
    if (event.type !== "session" || event.action !== "aborted") {
      return;
    }
    const sessionKey = event.sessionKey?.trim();
    if (!sessionKey) {
      return;
    }
    if (!withinBudget(sessionKey, Date.now())) {
      log.warn(
        `auto-continue budget exhausted for session ${sessionKey} — not resuming to avoid an abort loop`,
        {
          sessionKey,
          maxContinues: MAX_CONTINUES,
          windowMinutes: Math.round(WINDOW_MS / 60000),
        },
      );
      return;
    }

    enqueueSystemEvent(
      "Your previous run was interrupted by the stuck-session watchdog before it finished. " +
        "Pick up exactly where you left off: re-check the state of the work you were doing " +
        "(files, queues, tasks), figure out what still needs to happen, and continue " +
        "autonomously. Do not wait for a new instruction. Flush short progress text often so " +
        "the run is not misclassified as stalled again.",
      { sessionKey },
    );
    // "immediate", not "event": an event wake defers to `nextDueMs` once the
    // agent has run before (see heartbeat-cooldown.ts), so every abort after the
    // first would wait out the whole heartbeat interval and the run stays silent
    // exactly when the backstop is needed. Immediate keeps the flood guard, and
    // the loop-guard above is what bounds resumes.
    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      reason: "auto-continue:session-aborted",
      sessionKey,
    });
    // Queuing is silent otherwise, so an operator cannot tell a hook that never
    // ran from a continuation that was queued but never woken.
    log.info(`auto-continue queued a continuation for session ${sessionKey}`, {
      sessionKey,
      maxContinues: MAX_CONTINUES,
      windowMinutes: Math.round(WINDOW_MS / 60000),
    });
  } catch (error) {
    log.warn(`auto-continue failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export default handler;
