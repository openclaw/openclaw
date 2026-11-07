import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("update/diagnostics");
const SLOW_PHASE_MS = 30_000;

type PhaseFields = {
  action?: string;
  operationId?: string;
  remainingMs?: number;
  childPid?: number;
};
type PhaseOutcome = {
  outcome?: string;
  code?: number | null;
  status?: string;
  termination?: string;
  cleanup?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  childPid?: number;
};

/** Fixed scalar diagnostics only; never pass command arguments, output or authority data. */
export function logUpdatePhase(
  phase: string,
  event: "start" | "slow" | "end",
  startedAtMs: number,
  fields: PhaseFields & PhaseOutcome = {},
): void {
  const now = Date.now();
  const elapsedMs = Math.max(0, now - startedAtMs);
  try {
    const message = `update-phase ${JSON.stringify({
      timestamp: new Date(now).toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      phase,
      event,
      startedAtMs,
      elapsedMs,
      ...fields,
    })}`;
    // File-only so a --json lifecycle command keeps its terminal response intact.
    if (event !== "start" && elapsedMs >= SLOW_PHASE_MS) {
      log.warn(message, { consoleMessage: false });
    } else {
      log.debug(message, { consoleMessage: false });
    }
  } catch {
    // Logging must never change update, authority or cleanup outcomes.
  }
}

/** The unref'd warning observes a long await; it never cancels or bounds the operation. */
export function startUpdatePhase(phase: string, fields: PhaseFields = {}) {
  const startedAtMs = Date.now();
  logUpdatePhase(phase, "start", startedAtMs, fields);
  const warning = setTimeout(
    () => logUpdatePhase(phase, "slow", startedAtMs, fields),
    SLOW_PHASE_MS,
  );
  warning.unref?.();
  let ended = false;
  return (outcome: PhaseOutcome = {}) => {
    if (ended) {
      return;
    }
    ended = true;
    clearTimeout(warning);
    logUpdatePhase(phase, "end", startedAtMs, { ...fields, outcome: "ok", ...outcome });
  };
}

export async function withUpdatePhase<T>(
  phase: string,
  operation: () => Promise<T>,
  fields: PhaseFields = {},
): Promise<T> {
  const end = startUpdatePhase(phase, fields);
  try {
    const result = await operation();
    end();
    return result;
  } catch (error) {
    end({ outcome: "error" });
    throw error;
  }
}
