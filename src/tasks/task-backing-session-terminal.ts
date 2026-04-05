import type { BackingSessionSnapshot } from "./task-lifecycle-status.js";
import type { TaskStatus } from "./task-registry.types.js";

export function resolveTaskTerminalStatusFromBackingSession(
  backingSession: BackingSessionSnapshot,
): Extract<TaskStatus, "succeeded" | "failed" | "timed_out" | "cancelled"> | undefined {
  switch (backingSession.state) {
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "timeout":
      return "timed_out";
    case "killed":
      return "cancelled";
    default:
      return undefined;
  }
}

export function resolveTaskTerminalEvidenceText(backingSession: BackingSessionSnapshot): {
  error?: string;
  terminalSummary?: string;
} {
  switch (backingSession.state) {
    case "done":
      return { terminalSummary: "Backing session finished." };
    case "failed":
      return { error: "Backing session failed." };
    case "timeout":
      return { error: "Backing session timed out." };
    case "killed":
      return { error: "Backing session was killed." };
    default:
      return {};
  }
}

export function resolveTaskTerminalAtFromBackingSession(
  backingSession: BackingSessionSnapshot,
  fallbackAt: number,
): number {
  return backingSession.endedAt ?? backingSession.recordedAt ?? fallbackAt;
}
