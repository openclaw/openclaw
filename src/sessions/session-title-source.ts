import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveSkillCommandInvocation } from "../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../skills/types.js";

export const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;

/** Select task text, not chat controls, using the same skill invocation metadata as dispatch. */
export function resolveSessionTitleSource(
  message: string,
  skillCommands: SkillCommandSpec[] = [],
): string | null {
  const text = stripInboundMetadata(message).trim();
  const source = text.startsWith("/")
    ? resolveSkillCommandInvocation({ commandBodyNormalized: text, skillCommands })?.args?.trim()
    : text;
  return source ? truncateUtf16Safe(source, SESSION_TITLE_SOURCE_MAX_CHARS) : null;
}
