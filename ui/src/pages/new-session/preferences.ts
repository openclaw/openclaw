import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FastMode } from "../../api/types.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const STORAGE_KEY_PREFIX = "openclaw.new-session.preferences.v1:";
const IDENTITY_KEY_PREFIX = "new-session.v1:";
export const PREFS_MIGRATION_KEY = "new-session.migration.v1";
// users.prefs is already authenticated-user and Gateway scoped. Null deletes this key.
export const PALETTE_PREFERENCE_KEY = "new-session.palette.v1";

export type PaletteSessionPreference = {
  agentId: string;
  selection: NewSessionPreference;
};

export function decodePalettePreference(value: unknown): PaletteSessionPreference | null {
  if (!isRecord(value) || typeof value.agentId !== "string" || !value.agentId.trim()) {
    return null;
  }
  const selection = normalizePreference(value.selection);
  if (!selection || !isRecord(value.selection)) {
    return null;
  }
  // Empty placement fields are explicit overrides, not permission to inherit a /new choice.
  for (const key of ["folder", "projectId", "baseRef"] as const) {
    const field = value.selection[key];
    if (typeof field === "string") {
      selection[key] = field.trim();
    }
  }
  // The palette owns placement knobs; model/thinking continue to follow ordinary defaults.
  delete selection.model;
  delete selection.agentRuntime;
  delete selection.thinkingLevel;
  delete selection.fastMode;
  delete selection.worktreeName;
  return { agentId: normalizeAgentId(value.agentId), selection };
}

export type NewSessionWhere =
  | { kind: "local" }
  | { kind: "auto-device" }
  | { kind: "device"; id: string }
  | { kind: "cloud"; id: string };

export function resolveNewSessionWhere(params: {
  cloudProfileId: string;
  deviceId: string;
  autoDevice: boolean;
}): NewSessionWhere {
  return params.cloudProfileId
    ? { kind: "cloud", id: params.cloudProfileId }
    : params.deviceId
      ? { kind: "device", id: params.deviceId }
      : params.autoDevice
        ? { kind: "auto-device" }
        : { kind: "local" };
}

export type NewSessionPreference = {
  workspace?: string;
  folder?: string;
  where?: NewSessionWhere;
  projectId?: string;
  worktree?: boolean;
  freshWorkspace?: boolean;
  baseRef?: string;
  worktreeName?: string;
  model?: string;
  agentRuntime?: string;
  thinkingLevel?: string;
  fastMode?: FastMode;
};

export function hasNewSessionModelPreference(
  preference: NewSessionPreference | null | undefined,
): preference is NewSessionPreference {
  return Boolean(
    preference?.model || preference?.thinkingLevel || preference?.fastMode !== undefined,
  );
}

export function resolveNewSessionFolderPreference(
  preference: NewSessionPreference | null,
  workspace: string,
) {
  const storedFolder = preference?.folder ?? "";
  const workspaceMoved =
    Boolean(storedFolder) &&
    storedFolder === preference?.workspace &&
    preference.workspace !== workspace;
  const folder = storedFolder && !workspaceMoved ? storedFolder : workspace;
  return {
    folder,
    workspaceMoved,
    freshWorkspace:
      preference?.freshWorkspace ??
      !(preference?.worktree === true || preference?.projectId || (folder && folder !== workspace)),
  };
}

type PersistedPreferences = {
  agents?: Record<string, NewSessionPreference>;
};

function storageKey(gatewayUrl: string): string {
  return `${STORAGE_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

function normalizePreference(value: unknown): NewSessionPreference | null {
  if (!isRecord(value)) {
    return null;
  }
  const preference: NewSessionPreference = {};
  for (const key of [
    "workspace",
    "folder",
    "projectId",
    "baseRef",
    "worktreeName",
    "model",
    "thinkingLevel",
  ] as const) {
    const normalized = normalizeOptionalString(value[key]);
    if (normalized) {
      preference[key] = normalized;
    }
  }
  const agentRuntime = normalizeOptionalString(value.agentRuntime);
  if (preference.model && agentRuntime) {
    preference.agentRuntime = agentRuntime;
  }
  if (typeof value.fastMode === "boolean" || value.fastMode === "auto") {
    preference.fastMode = value.fastMode;
  }
  if (typeof value.worktree === "boolean") {
    preference.worktree = value.worktree;
  }
  if (typeof value.freshWorkspace === "boolean") {
    preference.freshWorkspace = value.freshWorkspace;
  } else if (preference.worktree === true) {
    // Preserve the legacy source choice before Git discovery clears worktree availability.
    preference.freshWorkspace = false;
  }
  const where = normalizeWhere(value.where);
  if (where) {
    preference.where = where;
  }
  return Object.keys(preference).length ? preference : null;
}

function normalizeWhere(value: unknown): NewSessionWhere | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }
  if (value.kind === "local" || value.kind === "auto-device") {
    return { kind: value.kind };
  }
  const id = normalizeOptionalString(value.id);
  return id && (value.kind === "device" || value.kind === "cloud")
    ? { kind: value.kind, id }
    : undefined;
}

function readStore(storage: Storage, gatewayUrl: string): PersistedPreferences {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(gatewayUrl)) ?? "null") as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed as PersistedPreferences;
  } catch {
    return {};
  }
}

export function loadNewSessionPreference(
  gatewayUrl: string,
  agentId: string,
): NewSessionPreference | null {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!storage || !gatewayUrl || !normalizedAgentId) {
    return null;
  }
  return normalizePreference(readStore(storage, gatewayUrl).agents?.[normalizedAgentId]);
}

export function loadBrowserPreferences(gatewayUrl: string): Record<string, NewSessionPreference> {
  const storage = getSafeLocalStorage();
  if (!storage || !gatewayUrl) {
    return {};
  }
  const entries = Object.entries(readStore(storage, gatewayUrl).agents ?? {}).flatMap(
    ([agentId, value]) => {
      const normalizedAgentId = normalizeAgentId(agentId);
      const preference = normalizePreference(value);
      return normalizedAgentId && preference ? [[normalizedAgentId, preference] as const] : [];
    },
  );
  return Object.fromEntries(entries);
}

export function encodeIdentityPreferences(
  preferences: Record<string, NewSessionPreference>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(preferences)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([agentId, preference]) => [`${IDENTITY_KEY_PREFIX}${agentId}`, preference]),
  );
}

export function decodeIdentityPreferences(
  entries: Record<string, unknown>,
): Record<string, NewSessionPreference> {
  return Object.fromEntries(
    Object.entries(entries).flatMap(([key, value]) => {
      if (!key.startsWith(IDENTITY_KEY_PREFIX)) {
        return [];
      }
      const agentId = normalizeAgentId(key.slice(IDENTITY_KEY_PREFIX.length));
      const preference = normalizePreference(value);
      return agentId && preference ? [[agentId, preference] as const] : [];
    }),
  );
}

export function replaceBrowserPreference(
  gatewayUrl: string,
  agentId: string,
  preference: NewSessionPreference,
): boolean {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!storage || !gatewayUrl || !normalizedAgentId) {
    return false;
  }
  const store = readStore(storage, gatewayUrl);
  const agents = { ...store.agents };
  const normalized = normalizePreference(preference);
  if (normalized) {
    agents[normalizedAgentId] = normalized;
  } else {
    // Clearing the final selection removes the preference; it is not an omitted patch.
    delete agents[normalizedAgentId];
  }
  try {
    storage.setItem(
      storageKey(gatewayUrl),
      JSON.stringify({ ...store, agents } satisfies PersistedPreferences),
    );
    return true;
  } catch {
    // Browser storage can be disabled or full; callers can report unconfirmed writes.
    return false;
  }
}
