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
export type SessionsListResultBase<TDefaults, TRow> = {
    ts: number;
    path: string;
    count: number;
    defaults: TDefaults;
    sessions: TRow[];
};
export type SessionsPatchResultBase<TEntry> = {
    ok: true;
    path: string;
    key: string;
    entry: TEntry;
};
