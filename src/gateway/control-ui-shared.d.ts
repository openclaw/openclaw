declare const CONTROL_UI_AVATAR_PREFIX = "/avatar";
export declare function normalizeControlUiBasePath(basePath?: string): string;
export declare function buildControlUiAvatarUrl(basePath: string, agentId: string): string;
export declare function resolveAssistantAvatarUrl(params: {
    avatar?: string | null;
    agentId?: string | null;
    basePath?: string;
}): string | undefined;
export { CONTROL_UI_AVATAR_PREFIX };
