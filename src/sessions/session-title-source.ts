import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { DEFAULT_RESET_TRIGGERS } from "../config/sessions/types.js";
import { resolveSkillCommandInvocation } from "../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../skills/types.js";

export const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;

// Control commands never feed titles; anything else starting with "/" is task
// text (pasted paths, free-form commands) once no registered skill claims it.
// A reset trigger carrying arguments ("/new please focus on X") still reads as
// task text here; the reset consumer owns that flow and consumes it first.
function isSessionControlCommand(text: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(text);
  return DEFAULT_RESET_TRIGGERS.some(
    (trigger) => normalizeLowercaseStringOrEmpty(trigger) === normalized,
  );
}

/** Slash-prefixed source text can only be classified against the skill registry. */
export function needsSkillCommandsForSessionTitle(message: string): boolean {
  return stripInboundMetadata(message).trim().startsWith("/");
}

/** Select task text, not chat controls or internal wakes, using dispatch's skill metadata. */
export function resolveSessionTitleSource(
  message: string,
  skillCommands: SkillCommandSpec[] = [],
): string | null {
  const text = stripInboundMetadata(message).trim();
  let source = text;
  if (text.startsWith("/")) {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: text,
      skillCommands,
    });
    if (invocation) {
      // Registered skill command: its arguments carry the task text; a bare
      // command has no title source.
      source = invocation.args?.trim() ?? "";
    } else if (isSessionControlCommand(text)) {
      source = "";
    } else {
      source = text.replace(/^\/+/, "").trim();
    }
  }
  if (
    !source ||
    Object.values(INTERNAL_WAKE_TRANSCRIPT_PROMPTS).some((prompt) => source === prompt)
  ) {
    return null;
  }
  return truncateUtf16Safe(source, SESSION_TITLE_SOURCE_MAX_CHARS);
}
