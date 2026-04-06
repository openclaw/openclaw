import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SessionCompactionCheckpoint,
  SessionsCompactionBranchResult,
  SessionsCompactionListResult,
  SessionsCompactionRestoreResult,
  SessionsListResult,
} from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

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
  sessionsExpandedCheckpointKey: string | null;
  sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]>;
  sessionsCheckpointLoadingKey: string | null;
  sessionsCheckpointBusyKey: string | null;
  sessionsCheckpointErrorByKey: Record<string, string>;
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
    const res = await state.client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      state.sessionsResult = res;
    }
  } catch (err) {
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
        await state.client.request("sessions.delete", { key, deleteTranscript: true });
        deleted.push(key);
      } catch (err) {
        deleteErrors.push(String(err));
      }
    }
  } finally {
    state.sessionsLoading = false;
  }
  if (deleted.length > 0) {
    await loadSessions(state);
  }
  if (deleteErrors.length > 0) {
    state.sessionsError = deleteErrors.join("; ");
  }
  return deleted;
}

export async function toggleSessionCompactionCheckpoints(state: SessionsState, key: string) {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return;
  }
  if (state.sessionsExpandedCheckpointKey === trimmedKey) {
    state.sessionsExpandedCheckpointKey = null;
    return;
  }
  state.sessionsExpandedCheckpointKey = trimmedKey;
  if (state.sessionsCheckpointItemsByKey[trimmedKey]) {
    return;
  }
  state.sessionsCheckpointLoadingKey = trimmedKey;
  state.sessionsCheckpointErrorByKey = {
    ...state.sessionsCheckpointErrorByKey,
    [trimmedKey]: "",
  };
  try {
    const result = await state.client?.request<SessionsCompactionListResult>(
      "sessions.compaction.list",
      { key: trimmedKey },
    );
    if (result) {
      state.sessionsCheckpointItemsByKey = {
        ...state.sessionsCheckpointItemsByKey,
        [trimmedKey]: result.checkpoints ?? [],
      };
    }
  } catch (err) {
    state.sessionsCheckpointErrorByKey = {
      ...state.sessionsCheckpointErrorByKey,
      [trimmedKey]: String(err),
    };
  } finally {
    if (state.sessionsCheckpointLoadingKey === trimmedKey) {
      state.sessionsCheckpointLoadingKey = null;
    }
  }
}

export async function branchSessionFromCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
): Promise<string | null> {
  if (!state.client || !state.connected) {
    return null;
  }
  const confirmed = window.confirm(
    "Create a new child session from this pre-compaction checkpoint?",
  );
  if (!confirmed) {
    return null;
  }
  state.sessionsCheckpointBusyKey = checkpointId;
  try {
    const result = await state.client.request<SessionsCompactionBranchResult>(
      "sessions.compaction.branch",
      { key, checkpointId },
    );
    await loadSessions(state);
    return result?.key ?? null;
  } catch (err) {
    state.sessionsError = String(err);
    return null;
  } finally {
    if (state.sessionsCheckpointBusyKey === checkpointId) {
      state.sessionsCheckpointBusyKey = null;
    }
  }
}

export async function restoreSessionFromCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
) {
  if (!state.client || !state.connected) {
    return;
  }
  const confirmed = window.confirm(
    "Restore this session to the selected pre-compaction checkpoint?\n\nThis replaces the current active transcript for the session key.",
  );
  if (!confirmed) {
    return;
  }
  state.sessionsCheckpointBusyKey = checkpointId;
  try {
    await state.client.request<SessionsCompactionRestoreResult>("sessions.compaction.restore", {
      key,
      checkpointId,
    });
    await loadSessions(state);
  } catch (err) {
    state.sessionsError = String(err);
  } finally {
    if (state.sessionsCheckpointBusyKey === checkpointId) {
      state.sessionsCheckpointBusyKey = null;
    }
  }
}
