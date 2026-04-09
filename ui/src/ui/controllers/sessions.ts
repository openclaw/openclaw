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

function checkpointSignature(
  row:
    | {
        key: string;
        compactionCheckpointCount?: number;
        latestCompactionCheckpoint?: { checkpointId?: string; createdAt?: number } | null;
      }
    | undefined,
): string {
  return JSON.stringify({
    key: row?.key ?? "",
    count: row?.compactionCheckpointCount ?? 0,
    latestCheckpointId: row?.latestCompactionCheckpoint?.checkpointId ?? "",
    latestCreatedAt: row?.latestCompactionCheckpoint?.createdAt ?? 0,
  });
}

function invalidateCheckpointCacheForKey(state: SessionsState, key: string) {
  if (
    !(key in state.sessionsCheckpointItemsByKey) &&
    !(key in state.sessionsCheckpointErrorByKey)
  ) {
    return;
  }
  const nextItems = { ...state.sessionsCheckpointItemsByKey };
  const nextErrors = { ...state.sessionsCheckpointErrorByKey };
  delete nextItems[key];
  delete nextErrors[key];
  state.sessionsCheckpointItemsByKey = nextItems;
  state.sessionsCheckpointErrorByKey = nextErrors;
}

async function fetchSessionCompactionCheckpoints(state: SessionsState, key: string) {
  state.sessionsCheckpointLoadingKey = key;
  state.sessionsCheckpointErrorByKey = {
    ...state.sessionsCheckpointErrorByKey,
    [key]: "",
  };
  try {
    const result = await state.client?.request<SessionsCompactionListResult>(
      "sessions.compaction.list",
      { key },
    );
    if (result) {
      state.sessionsCheckpointItemsByKey = {
        ...state.sessionsCheckpointItemsByKey,
        [key]: result.checkpoints ?? [],
      };
    }
  } catch (err) {
    state.sessionsCheckpointErrorByKey = {
      ...state.sessionsCheckpointErrorByKey,
      [key]: String(err),
    };
  } finally {
    if (state.sessionsCheckpointLoadingKey === key) {
      state.sessionsCheckpointLoadingKey = null;
    }
  }
}

async function withSessionsLoading(state: SessionsState, run: () => Promise<void>) {
  if (state.sessionsLoading) {
    return;
  }
  state.sessionsLoading = true;
  state.sessionsError = null;
  try {
    await run();
  } finally {
    state.sessionsLoading = false;
  }
}

async function runCompactionMutation<T>(
  state: SessionsState,
  key: string,
  checkpointId: string,
  method: "sessions.compaction.branch" | "sessions.compaction.restore",
  confirmMessage: string,
): Promise<T | null> {
  if (!state.client || !state.connected || !window.confirm(confirmMessage)) {
    return null;
  }
  const client = state.client;
  state.sessionsCheckpointBusyKey = checkpointId;
  try {
    const result = await client.request<T>(method, { key, checkpointId });
    await loadSessions(state);
    return result;
  } catch (err) {
    state.sessionsError = String(err);
    return null;
  } finally {
    if (state.sessionsCheckpointBusyKey === checkpointId) {
      state.sessionsCheckpointBusyKey = null;
    }
  }
}

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
  const client = state.client;
  await withSessionsLoading(state, async () => {
    const previousRows = new Map(
      (state.sessionsResult?.sessions ?? []).map((row) => [row.key, row] as const),
    );
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
    const res = await client.request<SessionsListResult | undefined>("sessions.list", params);
    if (res) {
      state.sessionsResult = res;
      const nextKeys = new Set(res.sessions.map((row) => row.key));
      for (const key of Object.keys(state.sessionsCheckpointItemsByKey)) {
        if (!nextKeys.has(key)) {
          invalidateCheckpointCacheForKey(state, key);
        }
      }
      let expandedNeedsRefetch = false;
      for (const row of res.sessions) {
        const previous = previousRows.get(row.key);
        if (checkpointSignature(previous) !== checkpointSignature(row)) {
          invalidateCheckpointCacheForKey(state, row.key);
          if (state.sessionsExpandedCheckpointKey === row.key) {
            expandedNeedsRefetch = true;
          }
        }
      }
      const expandedKey = state.sessionsExpandedCheckpointKey;
      if (
        expandedKey &&
        nextKeys.has(expandedKey) &&
        (expandedNeedsRefetch || !state.sessionsCheckpointItemsByKey[expandedKey])
      ) {
        await fetchSessionCompactionCheckpoints(state, expandedKey);
      }
    }
  }).catch((err: unknown) => {
    if (!isMissingOperatorReadScopeError(err)) {
      state.sessionsError = String(err);
      return;
    }
    state.sessionsResult = null;
    state.sessionsError = formatMissingOperatorReadScopeMessage("sessions");
  });
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
  for (const field of [
    "label",
    "thinkingLevel",
    "fastMode",
    "verboseLevel",
    "reasoningLevel",
  ] as const) {
    if (field in patch) {
      params[field] = patch[field];
    }
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
  const client = state.client;
  if (state.sessionsLoading) {
    return [];
  }
  const confirmed = window.confirm(
    `Delete ${keys.length} ${keys.length === 1 ? "session" : "sessions"}?\n\nThis will delete the session entries and archive their transcripts.`,
  );
  if (!confirmed) {
    return [];
  }
  const deleted: string[] = [];
  const deleteErrors: string[] = [];
  await withSessionsLoading(state, async () => {
    for (const key of keys) {
      try {
        await client.request("sessions.delete", { key, deleteTranscript: true });
        deleted.push(key);
      } catch (err) {
        deleteErrors.push(String(err));
      }
    }
  });
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
  await fetchSessionCompactionCheckpoints(state, trimmedKey);
}

export async function branchSessionFromCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
): Promise<string | null> {
  const result = await runCompactionMutation<SessionsCompactionBranchResult>(
    state,
    key,
    checkpointId,
    "sessions.compaction.branch",
    "Create a new child session from this pre-compaction checkpoint?",
  );
  return result?.key ?? null;
}

export async function restoreSessionFromCheckpoint(
  state: SessionsState,
  key: string,
  checkpointId: string,
) {
  await runCompactionMutation<SessionsCompactionRestoreResult>(
    state,
    key,
    checkpointId,
    "sessions.compaction.restore",
    "Restore this session to the selected pre-compaction checkpoint?\n\nThis replaces the current active transcript for the session key.",
  );
}
