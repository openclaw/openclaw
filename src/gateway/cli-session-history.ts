import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAssistantMessagePhase } from "../shared/chat-message-content.js";
import {
  type ClaudeCliFallbackSeed,
  CLAUDE_CLI_PROVIDER,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.claude.js";
import {
  CODEX_CLI_PROVIDER,
  readCodexCliSessionMessages,
  resolveCodexCliBindingSessionId,
  resolveCodexCliSessionFilePath,
} from "./cli-session-history.codex.js";
import { mergeImportedChatHistoryMessages } from "./cli-session-history.merge.js";

const ANTHROPIC_PROVIDER = "anthropic";

export {
  readCodexCliSessionMessages,
  resolveCodexCliSessionFilePath,
  mergeImportedChatHistoryMessages,
  readClaudeCliFallbackSeed,
  readClaudeCliSessionMessages,
  resolveClaudeCliBindingSessionId,
  resolveClaudeCliSessionFilePath,
};
export type { ClaudeCliFallbackSeed };

function shouldKeepImportedHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return true;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return true;
  }
  return resolveAssistantMessagePhase(message) !== "commentary";
}

function cliHistoryImportMatchesProvider(importProvider: string, normalizedProvider: string): boolean {
  if (importProvider === normalizedProvider) {
    return true;
  }
  return importProvider === CLAUDE_CLI_PROVIDER && normalizedProvider === ANTHROPIC_PROVIDER;
}

export function augmentChatHistoryWithCliSessionImports(params: {
  entry: SessionEntry | undefined;
  provider?: string;
  localMessages: unknown[];
  homeDir?: string;
}): unknown[] {
  const normalizedProvider = normalizeProviderId(params.provider ?? "");
  const availableImports = [
    {
      provider: CODEX_CLI_PROVIDER,
      sessionId: resolveCodexCliBindingSessionId(params.entry),
      readMessages: (sessionId: string) =>
        readCodexCliSessionMessages({
          cliSessionId: sessionId,
          homeDir: params.homeDir,
        }),
    },
    {
      provider: CLAUDE_CLI_PROVIDER,
      sessionId: resolveClaudeCliBindingSessionId(params.entry),
      readMessages: (sessionId: string) =>
        readClaudeCliSessionMessages({
          cliSessionId: sessionId,
          homeDir: params.homeDir,
        }),
    },
  ].filter(
    (
      entry,
    ): entry is {
      provider: string;
      sessionId: string;
      readMessages: (sessionId: string) => unknown[];
    } => typeof entry.sessionId === "string" && entry.sessionId.length > 0,
  );
  if (availableImports.length === 0) {
    return params.localMessages;
  }
  if (params.entry?.suppressCliHistoryImport) {
    return params.localMessages;
  }

  const matchingImports = normalizedProvider
    ? availableImports.filter((entry) =>
        cliHistoryImportMatchesProvider(entry.provider, normalizedProvider),
      )
    : [];
  const importsToMerge = params.localMessages.length === 0 ? availableImports : matchingImports;
  if (importsToMerge.length === 0) {
    return params.localMessages;
  }

  const importedMessages = importsToMerge
    .flatMap((entry) => entry.readMessages(entry.sessionId))
    .filter(shouldKeepImportedHistoryMessage);
  return mergeImportedChatHistoryMessages({
    localMessages: params.localMessages,
    importedMessages,
  });
}
