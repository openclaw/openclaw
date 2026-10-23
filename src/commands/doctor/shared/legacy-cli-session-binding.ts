import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getCliSessionBinding } from "../../../config/sessions/cli-session-binding.js";
import type { SessionEntry } from "../../../config/sessions/types.js";

export function migrateLegacyClaudeSessionField(
  entry: SessionEntry,
  sessionKey: string,
  warnings?: string[],
): boolean {
  if (entry.claudeCliSessionId === undefined) {
    return false;
  }
  if (!getCliSessionBinding(entry, "claude-cli")) {
    const sessionId = normalizeOptionalString(entry.claudeCliSessionId);
    // An incomplete binding can carry account/checkpoint metadata for another
    // conversation. Preserve it rather than attaching that metadata to a guessed ID.
    const hasUnboundMetadata = Object.entries(entry.cliSessionBindings?.["claude-cli"] ?? {}).some(
      ([key, value]) => key !== "sessionId" && value !== undefined,
    );
    if (!sessionId || hasUnboundMetadata) {
      const warning = `Session ${sessionKey}: legacy Claude CLI binding needs manual reconciliation; legacy binding state was preserved.`;
      if (warnings && !warnings.includes(warning)) {
        warnings.push(warning);
      }
      return false;
    }
    entry.cliSessionBindings = {
      ...entry.cliSessionBindings,
      "claude-cli": { sessionId },
    };
  }
  delete entry.claudeCliSessionId;
  return true;
}
