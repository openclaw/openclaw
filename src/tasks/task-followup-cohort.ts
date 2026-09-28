import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { FollowupCompletionOwner } from "./task-followup-completion.types.js";

// Weak projection only: the task run owner retains custody and makes every decision.
const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.tasks.followupCohorts"),
  () => new WeakMap<SubagentRunRecord, FollowupCompletionOwner>(),
);
export function getFollowupCohortOwner(entry: SubagentRunRecord) {
  return owners.get(entry);
}
export function bindFollowupCohortOwner(entry: SubagentRunRecord, owner: FollowupCompletionOwner) {
  owners.set(entry, owner);
}
export function transferFollowupCohort(previous: SubagentRunRecord, next: SubagentRunRecord) {
  const owner = owners.get(previous);
  if (!owner) {
    return () => {};
  }
  // Keep the restriction even when a replacement cannot inherit the old obligation.
  owners.set(next, owner);
  return owner.replaceCohortEntry(previous, next);
}
