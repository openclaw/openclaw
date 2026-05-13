import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  resolveClaudeCliHistoryJsonlPath,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
} from "./cli-session-history.claude.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const ANTHROPIC_PROVIDER = "anthropic";

export {
  mergeImportedChatHistoryMessages,
  resolveClaudeCliHistoryJsonlPath,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
};
export type { ClaudeCliFallbackSeed };

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  const cliSessionId = resolveClaudeCliBindingSessionId(params.entry);
  if (!cliSessionId) {
    return params.localMessages;
  }

  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  if (
    normalizedProvider &&
    normalizedProvider !== CLAUDE_CLI_PROVIDER &&
    normalizedProvider !== ANTHROPIC_PROVIDER &&
    params.localMessages.length > 0
  ) {
    return params.localMessages;
  }

  const importedMessages = readClaudeCliSessionMessages({
    cliSessionId,
    homeDir: params.homeDir,
  });
  return mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
}
