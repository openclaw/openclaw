import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";

const STORAGE_KEY_PREFIX = "openclaw.new-session.preferences.v1:";
const IDENTITY_KEY_PREFIX = "new-session.v1:";
export const PREFS_MIGRATION_KEY = "new-session.migration.v1";

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
};

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
  const record = value;
  const workspace = normalizeOptionalString(record.workspace);
  const folder = normalizeOptionalString(record.folder);
  const projectId = normalizeOptionalString(record.projectId);
  const baseRef = normalizeOptionalString(record.baseRef);
  const worktreeName = normalizeOptionalString(record.worktreeName);
  const model = normalizeOptionalString(record.model);
  const agentRuntime = model ? normalizeOptionalString(record.agentRuntime) : undefined;
  const thinkingLevel = normalizeOptionalString(record.thinkingLevel);
  const worktree = typeof record.worktree === "boolean" ? record.worktree : undefined;
  // Preserve the legacy source choice before Git discovery can clear worktree availability.
  const freshWorkspace =
    typeof record.freshWorkspace === "boolean"
      ? record.freshWorkspace
      : worktree === true
        ? false
        : undefined;
  const where = normalizeWhere(record.where);
  if (
    !workspace &&
    !folder &&
    !where &&
    !projectId &&
    worktree === undefined &&
    freshWorkspace === undefined &&
    !baseRef &&
    !worktreeName &&
    !model &&
    !thinkingLevel
  ) {
    return null;
  }
  return {
    ...(workspace ? { workspace } : {}),
    ...(folder ? { folder } : {}),
    ...(where ? { where } : {}),
    ...(projectId ? { projectId } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(freshWorkspace !== undefined ? { freshWorkspace } : {}),
    ...(baseRef ? { baseRef } : {}),
    ...(worktreeName ? { worktreeName } : {}),
    ...(model ? { model } : {}),
    ...(agentRuntime ? { agentRuntime } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
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
): void {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalized = normalizePreference(preference);
  if (!storage || !gatewayUrl || !normalizedAgentId) {
    return;
  }
  const store = readStore(storage, gatewayUrl);
  const agents = { ...store.agents };
  if (normalized) {
    agents[normalizedAgentId] = normalized;
  } else {
    delete agents[normalizedAgentId];
  }
  try {
    storage.setItem(
      storageKey(gatewayUrl),
      JSON.stringify({
        ...store,
        agents,
      } satisfies PersistedPreferences),
    );
  } catch {
    // Browser storage can be disabled or full; preferences are best effort.
  }
}

export function patchNewSessionPreference(
  gatewayUrl: string,
  agentId: string,
  patch: NewSessionPreference,
): void {
  const storage = getSafeLocalStorage();
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!storage || !gatewayUrl || !normalizedAgentId) {
    return;
  }
  const store = readStore(storage, gatewayUrl);
  const current = normalizePreference(store.agents?.[normalizedAgentId]) ?? {};
  const next = normalizePreference({ ...current, ...patch });
  const agents = { ...store.agents };
  if (next) {
    agents[normalizedAgentId] = next;
  } else {
    // Clearing the final selection removes the preference; it is not an omitted patch.
    delete agents[normalizedAgentId];
  }
  try {
    storage.setItem(
      storageKey(gatewayUrl),
      JSON.stringify({
        ...store,
        agents,
      } satisfies PersistedPreferences),
    );
  } catch {
    // Browser storage can be disabled or full; preferences are best effort.
  }
}
