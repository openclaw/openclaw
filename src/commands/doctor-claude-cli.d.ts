import type { AuthProfileStore, OAuthCredential, TokenCredential } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
type ClaudeCliReadableCredential = Pick<OAuthCredential, "type" | "expires"> | Pick<TokenCredential, "type" | "expires">;
export declare function resolveClaudeCliProjectDirForWorkspace(params: {
    workspaceDir: string;
    homeDir?: string;
}): string;
export declare function noteClaudeCliHealth(cfg: OpenClawConfig, deps?: {
    noteFn?: typeof note;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    store?: AuthProfileStore;
    readClaudeCliCredentials?: () => ClaudeCliReadableCredential | null;
    resolveCommandPath?: (command: string, env?: NodeJS.ProcessEnv) => string | undefined;
    workspaceDir?: string;
}): void;
export {};
