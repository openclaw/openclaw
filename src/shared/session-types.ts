export type GatewayAgentIdentity = {
  name?: string;
  theme?: string;
  emoji?: string;
  avatar?: string;
  avatarUrl?: string;
};

export type GatewayAgentRow = {
  id: string;
  name?: string;
  identity?: GatewayAgentIdentity;
};

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
