import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { UiSettings } from "../storage.ts";
import type { SessionsListResult } from "../types.ts";

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
  sessionKey?: string;
  settings?: UiSettings;
  applySettings?: (next: UiSettings) => void;
};

function shouldPreserveMissingSessionKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return (
    normalized.includes(":subagent:") ||
    normalized.startsWith("cron:") ||
    normalized.includes(":cron:")
  );
}

function normalizeMissingSessionSelection(state: SessionsState, res: SessionsListResult) {
  const currentSessionKey = state.sessionKey?.trim();
  if (!currentSessionKey || shouldPreserveMissingSessionKey(currentSessionKey)) {
    return;
  }
  if (res.sessions.some((row) => row.key === currentSessionKey)) {
    return;
  }
  const preferredLastActive = state.settings?.lastActiveSessionKey?.trim();
  const nextSessionKey =
    (preferredLastActive &&
    preferredLastActive !== currentSessionKey &&
    res.sessions.some((row) => row.key === preferredLastActive)
      ? preferredLastActive
      : null) ??
    res.sessions.find((row) => row.key === "main")?.key ??
    res.sessions[0]?.key;
  if (!nextSessionKey || nextSessionKey === currentSessionKey) {
    return;
  }
  state.sessionKey = nextSessionKey;
  if (state.settings) {
    const nextSettings: UiSettings = {
      ...state.settings,
      sessionKey: nextSessionKey,
      lastActiveSessionKey: nextSessionKey,
    };
    if (typeof state.applySettings === "function") {
      state.applySettings(nextSettings);
    } else {
      state.settings = nextSettings;
    }
  }
}

export async function loadSessions(
  state: SessionsState,
  overrides?: {
    activeMinutes?: number;
    limit?: number;
    includeGlobal?: boolean;
    includeUnknown?: boolean;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.sessionsLoading) {
    return;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    const includeGlobal = overrides?.includeGlobal ?? state.sessionsIncludeGlobal;
    const includeUnknown = overrides?.includeUnknown ?? state.sessionsIncludeUnknown;
    const activeMinutes = overrides?.activeMinutes ?? toNumber(state.sessionsFilterActive, 0);
    const limit = overrides?.limit ?? toNumber(state.sessionsFilterLimit, 0);
    const params: Record<string, unknown> = {
      includeGlobal,
      includeUnknown,
    };
    if (activeMinutes > 0) {
      params.activeMinutes = activeMinutes;
    }
    if (limit > 0) {
      params.limit = limit;
    }
    const res = await state.client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      state.sessionsResult = res;
      normalizeMissingSessionSelection(state, res);
    }
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
    thinkingLevel?: string | null;
    fastMode?: boolean | null;
    verboseLevel?: string | null;
    reasoningLevel?: string | null;
  },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const params: Record<string, unknown> = { key };
  if ("label" in patch) {
    params.label = patch.label;
  }
  if ("thinkingLevel" in patch) {
    params.thinkingLevel = patch.thinkingLevel;
  }
  if ("fastMode" in patch) {
    params.fastMode = patch.fastMode;
  }
  if ("verboseLevel" in patch) {
    params.verboseLevel = patch.verboseLevel;
  }
  if ("reasoningLevel" in patch) {
    params.reasoningLevel = patch.reasoningLevel;
  }
  try {
    await state.client.request("sessions.patch", params);
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function deleteSession(state: SessionsState, key: string): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.sessionsLoading) {
    return false;
  }
  const confirmed = window.confirm(
    `Delete session "${key}"?\n\nDeletes the session entry and archives its transcript.`,
  );
  if (!confirmed) {
    return false;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await state.client.request("sessions.delete", { key, deleteTranscript: true });
    return true;
  } catch (err) {
    state.sessionsError = String(err);
    return false;
  } finally {
    state.sessionsLoading = false;
  }
}

export async function deleteSessionAndRefresh(state: SessionsState, key: string): Promise<boolean> {
  const deleted = await deleteSession(state, key);
  if (!deleted) {
    return false;
  }
  await loadSessions(state);
  return true;
}
