import { parseAgentSessionKey } from "./session-key.js";

/**
 * Extract the channel/provider segment from an agent session key.
 *
 * Session keys follow the format `agent:<agentId>:<channel>:<subtype>:<id>`.
 * For example `agent:main:discord:slash:12345` → `"discord"`.
 *
 * This is a last-resort fallback for cases where the channel/provider
 * metadata is not available through the normal context propagation path.
 *
 * Fixes #53621 (Discord slash sessions) and related Telegram issues.
 */
export function inferChannelFromSessionKey(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  const rest = parsed.rest.trim();
  if (!rest) {
    return undefined;
  }
  const parts = rest.split(":").filter(Boolean);
  if (parts.length < 2) {
    // Need at least <channel>:<something> to be confident this is a channel segment
    // and not a mainKey or other identifier.
    return undefined;
  }
  const candidate = parts[0]?.trim().toLowerCase();
  if (!candidate) {
    return undefined;
  }
  return candidate;
}
