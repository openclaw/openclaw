import { normalizeAgentId } from "../routing/session-key.js";

export type GatewayAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type GatewayAgentModel = {
  primary?: string;
  fallbacks?: string[];
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: GatewayAgentIdentity;
  workspace?: string;
  model?: GatewayAgentModel;
};

export type SessionsListParamsKeyInput = {
  includeGlobal?: unknown;
  includeUnknown?: unknown;
  limit?: unknown;
  label?: unknown;
  spawnedBy?: unknown;
  agentId?: unknown;
  search?: unknown;
  activeMinutes?: unknown;
};

type BuildSessionsListParamsKeyOptions = {
  includeActiveMinutes?: boolean;
};

/**
 * Canonicalize sessions-list query fields for cache-key/lastHash tracking.
 *
 * Keep shared fields normalized consistently across runtime surfaces so server and UI
 * cannot silently drift on equivalent-but-not-identical inputs.
 */
export function buildSessionsListParamsKey(
  params: SessionsListParamsKeyInput,
  options: BuildSessionsListParamsKeyOptions = {},
): string {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : 0;
  const label = typeof params.label === "string" ? params.label.trim() : "";
  const spawnedBy = typeof params.spawnedBy === "string" ? params.spawnedBy : "";
  const agentId = typeof params.agentId === "string" ? normalizeAgentId(params.agentId) : "";
  const search = typeof params.search === "string" ? params.search.trim().toLowerCase() : "";
  const shared = {
    limit,
    includeGlobal: params.includeGlobal === true,
    includeUnknown: params.includeUnknown === true,
    label,
    spawnedBy,
    agentId,
    search,
  };
  if (!options.includeActiveMinutes) {
    return JSON.stringify(shared);
  }
  return JSON.stringify({
    ...shared,
    activeMinutes:
      typeof params.activeMinutes === "number" && Number.isFinite(params.activeMinutes)
        ? Math.max(0, Math.floor(params.activeMinutes))
        : 0,
  });
}

export type SessionsListResultBase<TDefaults, TRow> = {
  ts: number;
  path: string;
  count: number;
  defaults: TDefaults;
  sessions: TRow[];
};

/** `sessions.list` with `lastHash`: unchanged rows short-circuit. */
export type SessionsListUnchangedResult = {
  unchanged: true;
  hash: string;
  ts: number;
  count: number;
};

export type SessionsListRpcResultBase<TDefaults, TRow> =
  | (SessionsListResultBase<TDefaults, TRow> & { hash?: string })
  | SessionsListUnchangedResult;

export type SessionsPatchResultBase<TEntry> = {
  ok: true;
  path: string;
  key: string;
  entry: TEntry;
};
