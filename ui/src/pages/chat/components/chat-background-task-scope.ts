import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  parseAgentSessionKey,
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";

export function taskMatchesSessionScope(
  host: UiSessionDefaultsHost,
  task: TaskSummary,
  state: { sessionKey: string; agentId?: string; tasks: TaskSummary[] | null },
): "match" | "refresh" | "ignore" {
  let result: "refresh" | "ignore" = "ignore";
  for (const candidate of [
    { key: task.sessionKey },
    { key: task.childSessionKey, agentId: task.agentId },
    { key: task.ownerKey },
  ]) {
    const key = normalizeOptionalString(candidate.key);
    if (!key) {
      continue;
    }
    const identity = resolveUiConversationIdentity(host, key, candidate.agentId);
    if (identity.sessionKey !== state.sessionKey) {
      continue;
    }
    // TaskSummary exposes the executor, not the bare requester/owner's agent.
    // Only this conversation's authoritative list can admit that task ID.
    if (!parseAgentSessionKey(key) && !candidate.agentId) {
      result = "refresh";
    } else if (identity.agentId === state.agentId) {
      return "match";
    }
  }
  return result === "refresh" && state.tasks?.some((listed) => listed.id === task.id)
    ? "match"
    : result;
}
