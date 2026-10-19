import { normalizeCommandBody } from "./commands-registry.js";
import { parseSendPolicyCommandBody } from "./reply/commands-slash-parse.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";

type SendPolicyOverride = "allow" | "deny";

/** Parses /send commands and maps user-facing aliases to allow, deny, or inherit. */
export function parseSendPolicyCommand(raw?: string): {
  hasCommand: boolean;
  mode?: SendPolicyOverride | "inherit";
} {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { hasCommand: false };
  }
  return parseSendPolicyCommandBody(normalizeCommandBody(stripInboundMetadata(trimmed)));
}
