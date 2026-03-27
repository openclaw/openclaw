import { buildSessionsListParamsKey } from "../../../../src/shared/session-types.js";
import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult, SessionsListRpcResult } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

/**
 * Canonical fingerprint for `sessions.list` params when deciding whether `lastHash` is reusable.
 * Uses shared sessions-list params serialization with an extra `activeMinutes` term
 * so the UI avoids sending stale `lastHash` values when the time-window changes.
 */
export function buildSessionsListLastHashParamsKey(body: Record<string, unknown>): string {
  return buildSessionsListParamsKey(body, { includeActiveMinutes: true });
}

export type SessionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionsLoading: boolean;
  sessionsResult: SessionsListResult | null;
  /** Hash from last full `sessions.list` response; sent as `lastHash` for incremental refresh. */
  sessionsListLastHash: string | null;
  /** Serialized params key that produced `sessionsListLastHash`; hash is only sent when params match. */
  sessionsListLastHashParamsKey: string | null;
  sessionsError: string | null;
  sessionsFilterActive: string;
  sessionsFilterLimit: string;
  sessionsIncludeGlobal: boolean;
  sessionsIncludeUnknown: boolean;
};

export async function subscribeSessions(state: SessionsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("sessions.subscribe", {});
  } catch (err) {
    state.sessionsError = String(err);
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
    const paramsKey = buildSessionsListLastHashParamsKey(params);
    if (state.sessionsListLastHash && state.sessionsListLastHashParamsKey === paramsKey) {
      params.lastHash = state.sessionsListLastHash;
    }
    const res = await state.client.request<SessionsListRpcResult | undefined>(
      "sessions.list",
      params,
    );
    if (res) {
      if ("unchanged" in res && res.unchanged) {
        // Rows haven't changed, but count may have shifted (e.g. sessions beyond the visible
        // limit were added/removed).  Apply it so dashboard counters stay current.
        if (state.sessionsResult && typeof res.count === "number") {
          state.sessionsResult = {
            ...state.sessionsResult,
            count: res.count,
          };
        }
        state.sessionsListLastHash = res.hash;
        state.sessionsListLastHashParamsKey = paramsKey;
      } else {
        state.sessionsResult = res as SessionsListResult;
        state.sessionsListLastHash = typeof res.hash === "string" ? res.hash : null;
        state.sessionsListLastHashParamsKey = state.sessionsListLastHash ? paramsKey : null;
      }
    }
  } catch (err) {
    state.sessionsListLastHash = null;
    state.sessionsListLastHashParamsKey = null;
    if (isMissingOperatorReadScopeError(err)) {
      state.sessionsResult = null;
      state.sessionsError = formatMissingOperatorReadScopeMessage("sessions");
    } else {
      state.sessionsError = String(err);
    }
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
    // Store was mutated — clear stale hash so the refresh doesn't send a lastHash that can't match.
    state.sessionsListLastHash = null;
    state.sessionsListLastHashParamsKey = null;
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  }
}

export async function deleteSessionsAndRefresh(
  state: SessionsState,
  keys: string[],
): Promise<string[]> {
  if (!state.client || !state.connected || keys.length === 0) {
    return [];
  }
  if (state.sessionsLoading) {
    return [];
  }
  const noun = keys.length === 1 ? "session" : "sessions";
  const confirmed = window.confirm(
    `Delete ${keys.length} ${noun}?\n\nThis will delete the session entries and archive their transcripts.`,
  );
  if (!confirmed) {
    return [];
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  const deleted: string[] = [];
  const deleteErrors: string[] = [];
  try {
    for (const key of keys) {
      try {
        await state.client.request("sessions.delete", {
          key,
          deleteTranscript: true,
        });
        deleted.push(key);
      } catch (err) {
        deleteErrors.push(String(err));
      }
    }
  } finally {
    state.sessionsLoading = false;
  }
  if (deleted.length > 0) {
    // Store was mutated — clear stale hash so the refresh doesn't send a lastHash that can't match.
    state.sessionsListLastHash = null;
    state.sessionsListLastHashParamsKey = null;
    await loadSessions(state);
  }
  if (deleteErrors.length > 0) {
    state.sessionsError = deleteErrors.join("; ");
  }
  return deleted;
}
