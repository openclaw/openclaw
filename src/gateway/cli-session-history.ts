import { resolveSuppressedCliHistoryImportProviders } from "../agents/cli-session.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveAssistantMessagePhase } from "../shared/chat-message-content.js";
import {
  CLAUDE_CLI_PROVIDER,
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

export {
  readCodexCliSessionMessages,
  resolveCodexCliSessionFilePath,
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
};

function shouldKeepImportedHistoryMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return true;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return true;
  }
  return resolveAssistantMessagePhase(message) !== "commentary";
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
  const suppressedProviders = new Set(resolveSuppressedCliHistoryImportProviders(params.entry));
  if (normalizedProvider && suppressedProviders.has(normalizedProvider)) {
    return params.localMessages;
  }
  const eligibleImports = availableImports.filter(
    (entry) => !suppressedProviders.has(entry.provider),
  );

  const matchingImports = normalizedProvider
    ? eligibleImports.filter((entry) => normalizedProvider === entry.provider)
    : [];
  const importsToMerge = normalizedProvider
    ? matchingImports
    : params.localMessages.length === 0
      ? eligibleImports
      : [];
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
