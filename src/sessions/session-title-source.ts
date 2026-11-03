import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveSkillCommandInvocation } from "../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../skills/types.js";

export const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;

/** Select task text, not chat controls or internal wakes, using dispatch's skill metadata. */
export function resolveSessionTitleSource(
  message: string,
  skillCommands: SkillCommandSpec[] = [],
): string | null {
  const text = stripInboundMetadata(message).trim();
  let source: string | undefined;
  if (text.startsWith("/")) {
    const skill = resolveSkillCommandInvocation({
      commandBodyNormalized: text,
      skillCommands,
    });
    if (skill) {
      // Bare skill commands carry no task text; args-only commands still name the session.
      source = skill.args?.trim();
    } else if (!hasControlCommand(text)) {
      // Pasted absolute paths and other non-command slash prefixes are real task text.
      source = text;
    }
  } else {
    source = text;
  }
  if (
    !source ||
    Object.values(INTERNAL_WAKE_TRANSCRIPT_PROMPTS).some((prompt) => source === prompt)
  ) {
    return null;
  }
  return truncateUtf16Safe(source, SESSION_TITLE_SOURCE_MAX_CHARS);
}