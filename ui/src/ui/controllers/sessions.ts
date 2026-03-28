import { normalizeAgentId } from "../../../../src/routing/session-key.js";
import { toNumber } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SessionsListResult, SessionsPatchResult } from "../types.ts";
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
};

const CONTROL_UI_SESSION_SLUG_MAX = 32;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function createControlUiSessionRandomSuffix(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 4);
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const array = new Uint8Array(2);
    globalThis.crypto.getRandomValues(array);
    return Array.from(array, (value) => value.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 4);
  }
  return Math.random().toString(16).slice(2, 6).padEnd(4, "0");
}

function formatControlUiSessionTimestamp(now: Date): string {
  return (
    [now.getFullYear(), pad2(now.getMonth() + 1), pad2(now.getDate())].join("") +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}`
  );
}

function formatControlUiSessionLabelTimestamp(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function slugifyControlUiSessionLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/['’"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, CONTROL_UI_SESSION_SLUG_MAX) || "chat"
  );
}

export function buildControlUiSessionKey(params: {
  agentId: string;
  label: string;
  now?: Date;
  randomSuffix?: string;
}): string {
  const now = params.now ?? new Date();
  const suffix = (params.randomSuffix ?? createControlUiSessionRandomSuffix()).trim().toLowerCase();
  const safeSuffix = suffix || createControlUiSessionRandomSuffix();
  const slug = slugifyControlUiSessionLabel(params.label);
  return `agent:${normalizeAgentId(params.agentId)}:ui:${formatControlUiSessionTimestamp(now)}-${slug}-${safeSuffix}`;
}

export function createDefaultControlUiSessionLabel(now: Date = new Date()): string {
  return `Chat ${formatControlUiSessionLabelTimestamp(now)}`;
}

export function resolveNewControlUiSessionLabel(
  input: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (input === null) {
    return null;
  }
  const trimmed = typeof input === "string" ? input.trim() : "";
  return trimmed || createDefaultControlUiSessionLabel(now);
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
): Promise<SessionsPatchResult | null> {
  if (!state.client || !state.connected) {
    return null;
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
    const result = await state.client.request<SessionsPatchResult>("sessions.patch", params);
    await loadSessions(state);
    return result ?? null;
  } catch (err) {
    state.sessionsError = String(err);
    return null;
  }
}

export async function createControlUiSession(
  state: SessionsState,
  params: {
    agentId: string;
    label: string;
    now?: Date;
    randomSuffix?: string;
  },
): Promise<SessionsPatchResult | null> {
  const label = params.label.trim();
  const key = buildControlUiSessionKey({ ...params, label });
  return patchSession(state, key, { label });
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
