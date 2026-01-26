import type { GatewayBrowserClient } from "../gateway";
import { buildAgentMainSessionKey } from "../../../../src/routing/session-key.js";
import { toast } from "../components/toast";
import { showDangerConfirmDialog } from "../components/confirm-dialog";
import { toNumber } from "../format";
import type { SessionsListResult } from "../types";

/**
 * Build the main session key for an agent.
 */
export function agentSessionKey(agentId: string, mainKey?: string): string {
  return buildAgentMainSessionKey({ agentId, mainKey });
}

/**
 * Find an existing session for the given agent.
 * Returns the session key if found, or null if no session exists.
 */
export function findSessionForAgent(
  sessions: SessionsListResult | null,
  agentId: string,
): string | null {
  if (!sessions?.sessions) return null;
  const prefix = `agent:${agentId.toLowerCase()}:`;
  const match = sessions.sessions.find(
    (s) => s.key.toLowerCase().startsWith(prefix),
  );
  return match?.key ?? null;
}

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
};

export async function loadSessions(state: SessionsState) {
  if (!state.client || !state.connected) return;
  if (state.sessionsLoading) return;
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const params: Record<string, unknown> = {
      includeGlobal: state.sessionsIncludeGlobal,
      includeUnknown: state.sessionsIncludeUnknown,
    };
    const activeMinutes = toNumber(state.sessionsFilterActive, 0);
    const limit = toNumber(state.sessionsFilterLimit, 0);
    if (limit > 0 && limit <= 200) {
      params.includeLastMessage = true;
      params.includeDerivedTitles = true;
    }
    if (activeMinutes > 0) params.activeMinutes = activeMinutes;
    if (limit > 0) params.limit = limit;
    const res = (await state.client.request("sessions.list", params)) as
      | SessionsListResult
      | undefined;
    if (res) state.sessionsResult = res;
  } catch (err) {
    state.sessionsError = String(err);
  } finally {
    state.sessionsLoading = false;
  }
}

export async function patchSession(
  state: SessionsState,
  key: string,
  patch: {
    label?: string | null;
    tags?: string[] | null;
    thinkingLevel?: string | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  if (!state.client || !state.connected) return;
  const params: Record<string, unknown> = { key };
  if ("label" in patch) params.label = patch.label;
  if ("tags" in patch) params.tags = patch.tags;
  if ("thinkingLevel" in patch) params.thinkingLevel = patch.thinkingLevel;
  if ("verboseLevel" in patch) params.verboseLevel = patch.verboseLevel;
  if ("reasoningLevel" in patch) params.reasoningLevel = patch.reasoningLevel;
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function deleteSession(state: SessionsState, key: string) {
  if (!state.client || !state.connected) return;
  if (state.sessionsLoading) return;
  const confirmed = await showDangerConfirmDialog(
    "Delete Session",
    `Delete session "${key}"? This will delete the session entry and archive its transcript.`,
    "Delete",
  );
  if (!confirmed) return;
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.delete", { key, deleteTranscript: true });
    toast.success("Session deleted");
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
    toast.error("Failed to delete session");
  } finally {
    state.sessionsLoading = false;
  }
}

export async function deleteSessionsBulk(state: SessionsState, keys: string[]) {
  if (!state.client || !state.connected) return;
  if (state.sessionsLoading) return;
  const unique = [...new Set(keys.map((k) => String(k ?? "").trim()).filter(Boolean))];
  if (unique.length === 0) return;
  const confirmed = await showDangerConfirmDialog(
    "Delete Sessions",
    `Delete ${unique.length} session${unique.length === 1 ? "" : "s"}? This will delete the session entries and delete their transcripts.`,
    "Delete",
  );
  if (!confirmed) return;
  state.sessionsLoading = true;
  state.sessionsError = null;
  let deleted = 0;
  try {
    for (const key of unique) {
      await state.client.request("sessions.delete", { key, deleteTranscript: true });
      deleted += 1;
    }
    toast.success(`Deleted ${deleted} session${deleted === 1 ? "" : "s"}`);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
    toast.error(`Deleted ${deleted} session${deleted === 1 ? "" : "s"}, then failed`);
    await loadSessions(state);
  } finally {
    state.sessionsLoading = false;
  }
}
