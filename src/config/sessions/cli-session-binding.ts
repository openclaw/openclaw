// CLI session binding lookup shared by session lifecycle and agent runtime code.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, SessionEntry } from "./types.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/** Read the stored CLI session binding for a provider, including legacy Claude state. */
export function getCliSessionBinding(
  entry: SessionEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      ...(fromBindings?.forceReuse === true ? { forceReuse: true } : {}),
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      authEpochVersion: fromBindings?.authEpochVersion,
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      messageToolPolicyHash: normalizeOptionalString(fromBindings?.messageToolPolicyHash),
      promptToolNamesHash: normalizeOptionalString(fromBindings?.promptToolNamesHash),
      longTermMemoryDefaultPolicy: readLongTermMemoryDefaultPolicy(
        fromBindings?.longTermMemoryDefaultPolicy,
      ),
      cwdHash: normalizeOptionalString(fromBindings?.cwdHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
      mcpResumeHash: normalizeOptionalString(fromBindings?.mcpResumeHash),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    // Keep accepting the shipped Claude-only field until stored sessions migrate.
    const legacy = normalizeOptionalString(entry.claudeCliSessionId);
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

function readLongTermMemoryDefaultPolicy(
  value: unknown,
): CliSessionBinding["longTermMemoryDefaultPolicy"] {
  return value === "include" || value === "explicit-only" ? value : undefined;
}

/** Read just the reusable CLI session ID for a provider. */
export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}
