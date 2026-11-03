import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveSkillCommandInvocation } from "../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../skills/types.js";

export const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;

/** Pasted absolute paths keep a second slash (or UNC) after the leading "/". */
function isLeadingSlashPathText(text: string): boolean {
  return text.startsWith("//") || text.includes("/", 1);
}

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
    } else if (isLeadingSlashPathText(text)) {
      // Pasted absolute paths are real task text. Unregistered /command forms stay
      // untitled so control commands are not inferred without the command registry.
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
