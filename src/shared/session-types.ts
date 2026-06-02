/** Assistant identity fields surfaced through gateway session/list APIs. */
export type GatewayAgentIdentity = {
  /** Human-readable assistant name shown in clients. */
  name?: string;
  /** Optional UI theme token associated with the assistant. */
  theme?: string;
  /** Short emoji identity used when no avatar image is configured. */
  emoji?: string;
  /** Inline avatar value from config or agent metadata. */
  avatar?: string;
  /** Resolved avatar URL safe for clients to render directly. */
  avatarUrl?: string;
};

/** Model routing summary for a gateway agent row. */
export type GatewayAgentModel = {
  /** Primary provider/model id used for new turns. */
  primary?: string;
  /** Ordered fallback model ids available to the runtime. */
  fallbacks?: string[];
};

/** Runtime implementation selected for a gateway agent. */
export type GatewayAgentRuntime = {
  /** Runtime id consumed by gateway clients and session creation. */
  id: string;
  /** Fallback behavior when the requested runtime is unavailable. */
  fallback?: "openclaw" | "none";
  /** Configuration source that selected the runtime. */
  source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit" | "session-key";
};

/** Selectable thinking-level option returned to clients. */
export type GatewayThinkingLevelOption = {
  /** Stable option id stored in session/config payloads. */
  id: string;
  /** Human-readable label for UI pickers. */
  label: string;
};

/** Agent summary row returned by gateway session/defaults endpoints. */
export type GatewayAgentRow = {
  /** Agent id used by session keys and gateway calls. */
  id: string;
  /** Optional display name after identity/config resolution. */
  name?: string;
  /** Optional assistant identity payload for clients. */
  identity?: GatewayAgentIdentity;
  /** Workspace path associated with the agent, when known. */
  workspace?: string;
  /** Model routing summary for the agent. */
  model?: GatewayAgentModel;
  /** Runtime selection summary for the agent. */
  agentRuntime?: GatewayAgentRuntime;
  /** Rich thinking-level options for capable clients. */
  thinkingLevels?: GatewayThinkingLevelOption[];
  /** Legacy string options preserved for clients that do not render rich labels. */
  thinkingOptions?: string[];
  /** Default thinking-level id selected for new sessions. */
  thinkingDefault?: string;
};

/** Shared paginated session-list envelope used by gateway and plugin-facing APIs. */
export type SessionsListResultBase<TDefaults, TRow> = {
  /** Server timestamp for the list response. */
  ts: number;
  /** Backing store path used to build the response. */
  path: string;
  /** Number of rows returned in this page. */
  count: number;
  /** Total row count before pagination when available. */
  totalCount?: number;
  /** Limit applied to this page. */
  limitApplied?: number;
  /** Starting offset used for this page. */
  offset?: number;
  /** Next offset to request, or null when the page is exhausted. */
  nextOffset?: number | null;
  /** True when another page is available. */
  hasMore?: boolean;
  /** Defaults block paired with the listed rows. */
  defaults: TDefaults;
  /** Session rows for this page. */
  sessions: TRow[];
};

/** Shared response envelope for a successful session metadata patch. */
export type SessionsPatchResultBase<TEntry> = {
  /** Success marker for discriminated patch results. */
  ok: true;
  /** Backing store path that was patched. */
  path: string;
  /** Session key whose entry was updated. */
  key: string;
  /** Updated session entry. */
  entry: TEntry;
};
