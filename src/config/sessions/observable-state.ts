import path from "node:path";
import { saveJsonFile } from "../../infra/json-file.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

export type ObservableSessionStateEntry = {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  updatedAt: number;
  model?: string;
  provider?: string;
  status?: NonNullable<SessionEntry["status"]>;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  channel?: string;
  label?: string;
  displayName?: string;
  subject?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
  spawnedWorkspaceDir?: string;
};

export type ObservableSessionStateSnapshot = {
  version: 1;
  generatedAt: string;
  agentId: string;
  total: number;
  sessions: ObservableSessionStateEntry[];
};

function resolveAgentIdFromStorePath(storePath: string): string {
  const normalized = path.normalize(path.resolve(storePath));
  const parts = normalized.split(path.sep).filter(Boolean);
  const sessionsIndex = parts.lastIndexOf("sessions");
  if (sessionsIndex >= 2 && parts[sessionsIndex - 2] === "agents") {
    return normalizeAgentId(parts[sessionsIndex - 1] ?? DEFAULT_AGENT_ID);
  }
  return DEFAULT_AGENT_ID;
}

export function resolveObservableSessionStatePathForStore(storePath: string): string {
  return path.join(path.dirname(path.resolve(storePath)), "session-state.json");
}

function toObservableSessionStateEntry(params: {
  sessionKey: string;
  entry: SessionEntry;
  agentId: string;
}): ObservableSessionStateEntry {
  const { entry } = params;
  return {
    sessionKey: params.sessionKey,
    sessionId: entry.sessionId,
    agentId: params.agentId,
    updatedAt: entry.updatedAt,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.modelProvider ? { provider: entry.modelProvider } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.startedAt != null ? { startedAt: entry.startedAt } : {}),
    ...(entry.endedAt != null ? { endedAt: entry.endedAt } : {}),
    ...(entry.runtimeMs != null ? { runtimeMs: entry.runtimeMs } : {}),
    ...(entry.channel ? { channel: entry.channel } : {}),
    ...(entry.label ? { label: entry.label } : {}),
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.subject ? { subject: entry.subject } : {}),
    ...(entry.parentSessionKey ? { parentSessionKey: entry.parentSessionKey } : {}),
    ...(entry.spawnedBy ? { spawnedBy: entry.spawnedBy } : {}),
    ...(entry.spawnedWorkspaceDir ? { spawnedWorkspaceDir: entry.spawnedWorkspaceDir } : {}),
  };
}

export function saveObservableSessionState(params: {
  storePath: string;
  store: Record<string, SessionEntry>;
}) {
  const agentId = resolveAgentIdFromStorePath(params.storePath);
  const sessions = Object.entries(params.store)
    .map(([sessionKey, entry]) => toObservableSessionStateEntry({ sessionKey, entry, agentId }))
    .toSorted((left, right) => right.updatedAt - left.updatedAt);

  const snapshot: ObservableSessionStateSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    agentId,
    total: sessions.length,
    sessions,
  };

  saveJsonFile(resolveObservableSessionStatePathForStore(params.storePath), snapshot);
}
