import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveSkillCommandInvocation } from "../skills/discovery/chat-command-invocation.js";
import type { SkillCommandSpec } from "../skills/types.js";

export const SESSION_TITLE_SOURCE_MAX_CHARS = 1_000;

/** Slash-prefixed source text can only be classified against the skill registry. */
export function needsSkillCommandsForSessionTitle(message: string): boolean {
  return stripInboundMetadata(message).trim().startsWith("/");
}

/**
 * Select task text, not chat controls or internal wakes, using dispatch's
 * skill metadata. Callers that run with the full runtime pass the canonical
 * control-command detector (`isControlCommandMessage`) so control commands
 * stay titleless; callers without it keep the legacy titleless contract for
 * slash text, which keeps this module loadable in extracted wrapper contexts.
 */
export function resolveSessionTitleSource(
  message: string,
  skillCommands?: SkillCommandSpec[],
  options?: { isControlCommand?: (text: string) => boolean },
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
    } else if (
      skillCommands === undefined ||
      !options?.isControlCommand ||
      options.isControlCommand(text)
    ) {
      // Without the skill registry, without the canonical control detector, or
      // for an actual control command, slash text has no title source.
      source = "";
    } else {
      // The detector ruled out a control command and a registry was
      // consulted: unregistered slash text (pasted paths, free-form commands)
      // is task text.
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
