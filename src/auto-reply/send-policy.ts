/** Parsing for the /send override command embedded in inbound auto-reply text. */
import { normalizeCommandBody } from "./commands-registry.js";
import { parseSendPolicyCommandBody } from "./reply/commands-slash-parse.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";

type SendPolicyOverride = "allow" | "deny";

/** Parses /send commands and maps user-facing aliases to allow, deny, or inherit. */
export function parseSendPolicyCommand(raw?: string): {
  hasCommand: boolean;
  mode?: SendPolicyOverride | "inherit";
} {
  if (!raw) {
    return { hasCommand: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { hasCommand: false };
  }
  const stripped = stripInboundMetadata(trimmed);
  const normalized = normalizeCommandBody(stripped);
  return parseSendPolicyCommandBody(normalized);
}
