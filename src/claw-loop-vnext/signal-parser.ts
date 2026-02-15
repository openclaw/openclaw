import type { Signal } from "./types.js";

function normalizeReason(reason: string): string {
  return reason.trim().replace(/\s+/g, " ");
}

function signalKey(type: Signal["type"], value: string): string {
  return `${type}:${value}`;
}

export function extractSignals(text: string): Signal[] {
  const out: Signal[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const phaseComplete = line.match(/^\s*PHASE_COMPLETE:\s*([A-Za-z0-9_\-.]+)\s*$/);
    if (phaseComplete) {
      const phaseId = phaseComplete[1];
      out.push({
        type: "phase_complete",
        phaseId,
        raw: line,
        dedupeKey: signalKey("phase_complete", phaseId),
      });
      continue;
    }

    const phaseBlocked = line.match(/^\s*PHASE_BLOCKED:\s*(.+)$/);
    if (phaseBlocked) {
      const reason = normalizeReason(phaseBlocked[1]);
      out.push({
        type: "phase_blocked",
        reason,
        raw: line,
        dedupeKey: signalKey("phase_blocked", reason),
      });
      continue;
    }

    const goalComplete = line.match(/^\s*GOAL_COMPLETE\s*$/);
    if (goalComplete) {
      out.push({
        type: "goal_complete",
        raw: line,
        dedupeKey: signalKey("goal_complete", "1"),
      });
      continue;
    }

    const promiseDone = line.match(/^\s*<promise>\s*DONE(?::|\b).*<\/promise>\s*$/i);
    if (promiseDone) {
      out.push({
        type: "promise_done",
        raw: line,
        dedupeKey: signalKey("promise_done", "1"),
      });
    }
  }

  return out;
}
