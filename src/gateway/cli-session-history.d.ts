import type { SessionEntry } from "../config/sessions.js";
import { readClaudeCliSessionMessages, resolveClaudeCliSessionFilePath } from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";
export { mergeImportedChatHistoryMessages, readClaudeCliSessionMessages, resolveClaudeCliSessionFilePath, };
export declare function augmentChatHistoryWithCliSessionImports(params: {
    entry: SessionEntry | undefined;
    provider?: string;
    localMessages: unknown[];
    homeDir?: string;
}): unknown[];
