import type { SessionEntry } from "../config/sessions.js";
export declare const CLAUDE_CLI_PROVIDER = "claude-cli";
type TranscriptLikeMessage = Record<string, unknown>;
export declare function resolveClaudeCliBindingSessionId(entry: SessionEntry | undefined): string | undefined;
export declare function resolveClaudeCliSessionFilePath(params: {
    cliSessionId: string;
    homeDir?: string;
}): string | undefined;
export declare function readClaudeCliSessionMessages(params: {
    cliSessionId: string;
    homeDir?: string;
}): TranscriptLikeMessage[];
export {};
