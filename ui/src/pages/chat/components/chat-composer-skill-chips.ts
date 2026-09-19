import type { ComposerChip, ComposerChipContext } from "../../../components/composer-editor.ts";
import { icons } from "../../../components/icons.ts";
import { SLASH_COMMANDS } from "../../../lib/chat/commands.ts";

/** Skill presentation derives from the active command catalog; drafts keep their original text. */
export function resolveComposerSkillChips(
  value: string,
  context: ComposerChipContext,
): readonly ComposerChip[] {
  const chips: ComposerChip[] = [];
  for (const match of value.matchAll(/(?:^|\s)([/$])([-a-zA-Z0-9_:]+)(?=$|[\s.,!?;:)\]}])/gu)) {
    const name = (match[2] ?? "").replace(/:+$/gu, "");
    const prefix = match[1] ?? "";
    const token = `${prefix}${name}`;
    const start = match.index + match[0].indexOf(prefix);
    const end = start + token.length;
    // An exact match is still a query until completion, a separator, or blur confirms it.
    if (context.editing && context.caret === end && !/\s/u.test(value[end] ?? "")) {
      continue;
    }
    const command = SLASH_COMMANDS.find(
      (entry) =>
        entry.source === "skill" &&
        entry.name === name &&
        (prefix === "/" || entry.skillModelVisible === true),
    );
    if (!command) {
      continue;
    }
    chips.push({
      kind: "skill",
      start,
      end,
      label: command.skillDisplayName?.trim() || command.name.replace(/_+/gu, " "),
      icon: icons.pencilSparkles,
    });
  }
  return chips;
}
