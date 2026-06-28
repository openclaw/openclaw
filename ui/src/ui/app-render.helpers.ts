// Control UI module implements remaining legacy app render helpers.
import { resolveAgentIdFromSessionKey, normalizeAgentId } from "../lib/sessions/session-key.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../lib/string-coerce.ts";
import type { AppViewState } from "./app-view-state.ts";

export function resolveDashboardHeaderContext(
  state: Pick<AppViewState, "agentsList" | "sessionKey">,
): { agentLabel: string } {
  const agentId = resolveAgentIdFromSessionKey(state.sessionKey);
  const agent = state.agentsList?.agents.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === agentId,
  );
  const agentLabel =
    normalizeOptionalString(agent?.identity?.name) ??
    normalizeOptionalString(agent?.name) ??
    normalizeAgentId(agentId);
  return { agentLabel };
}
