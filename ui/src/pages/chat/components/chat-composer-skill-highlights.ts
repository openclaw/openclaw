import { SLASH_COMMANDS, findInlineSlashCompletion } from "../../../lib/chat/commands.ts";
import type { ComposerHighlightRange } from "./chat-composer-highlights.ts";
import { findSkillMentionTarget } from "./chat-composer-skill-menu.ts";

/** Decorate only references recognized by the existing picker/catalog owners. */
export function resolveComposerSkillHighlights(value: string): ComposerHighlightRange[] {
  const ranges: ComposerHighlightRange[] = [];
  if (value.trimStart().startsWith("/")) {
    const tokenEnd = value.search(/\S\s/u);
    const target = findInlineSlashCompletion(value, tokenEnd < 0 ? value.length : tokenEnd + 1);
    if (
      target &&
      SLASH_COMMANDS.some((command) => command.source === "skill" && command.name === target.query)
    ) {
      ranges.push({ start: target.start, end: target.start + target.query.length + 1 });
    }
    return ranges;
  }
  for (const match of value.matchAll(/\$/gu)) {
    const target = findSkillMentionTarget(value, match.index + 1);
    if (
      target &&
      SLASH_COMMANDS.some(
        (command) =>
          command.source === "skill" &&
          command.skillModelVisible === true &&
          command.name === target.query,
      )
    ) {
      ranges.push({ start: target.start, end: target.end });
    }
  }
  return ranges;
}
