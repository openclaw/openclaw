import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isControlCommandMessage } from "../auto-reply/command-detection.js";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveSkillCommandInvocation } from "../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../skills/types.js";

export const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;

/** Slash-prefixed source text can only be classified against the skill registry. */
export function needsSkillCommandsForSessionTitle(message: string): boolean {
  return stripInboundMetadata(message).trim().startsWith("/");
}

/** Select task text, not chat controls or internal wakes, using dispatch's skill metadata. */
export function resolveSessionTitleSource(
  message: string,
  skillCommands?: SkillCommandSpec[],
): string | null {
  const text = stripInboundMetadata(message).trim();
  let source = text;
  if (text.startsWith("/")) {
    const invocation = resolveSkillCommandInvocation({
      commandBodyNormalized: text,
      skillCommands: skillCommands ?? [],
    });
    if (invocation) {
      // Registered skill command: its arguments carry the task text; a bare
      // command has no title source.
      source = invocation.args?.trim() ?? "";
    } else if (isControlCommandMessage(text)) {
      // Canonical control commands (/new, /reset, /status, /model, ...) never
      // feed titles.
      source = "";
    } else if (skillCommands !== undefined) {
      // A registry was consulted: unregistered slash text (pasted paths,
      // free-form commands) is task text.
      source = text.replace(/^\/+/, "").trim();
    } else {
      // No registry available (deterministic goal derivation, Doctor repair):
      // preserve the legacy titleless contract for slash text.
      source = "";
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
