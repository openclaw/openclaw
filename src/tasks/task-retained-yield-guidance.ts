// Shared operator note for a running task whose current generation last started sessions_yield.
// The stored name is the tool start, not a confirmed pause. Successor activation clears it.
import type { TaskRecord } from "./task-registry.types.js";

export const RETAINED_YIELD_GUIDANCE = [
  "last started tool is sessions_yield; that is not a confirmed pause.",
  "A deferred or rejected sessions_yield can leave the same name until its result arrives.",
  "Review the exact owner and generation, pending inputs, descendants, outstanding continuations, and parent delivery before tasks.cancel.",
  "Age, delivery, or a quiet turn does not prove the child finished.",
].join(" ");

export function isRetainedYieldOwner(
  task: Pick<TaskRecord, "status" | "endedAt" | "lastToolName">,
): boolean {
  return (
    task.status === "running" && task.endedAt == null && task.lastToolName === "sessions_yield"
  );
}
