import { findMarkdownCodeRegions } from "../../../../packages/markdown-core/src/markdown-code-regions.js";
import { getSkillDisplayName, SLASH_COMMANDS } from "./commands.ts";

export { subscribeSlashCommands } from "./commands.ts";

export type ComposerSkillReference = { start: number; end: number; name: string; label: string };

/** Presentation only: the canonical $command remains the draft and wire format.
 * Unknown names, shell variables, escaped dollars and code stay ordinary text. */
export function readComposerSkillReferences(
  value: string,
  editingAt?: number,
): ComposerSkillReference[] {
  if (!value.includes("$") || value.trimStart().startsWith("/")) {
    return [];
  }
  const references: ComposerSkillReference[] = [];
  for (const match of value.matchAll(/\$([-a-zA-Z0-9_:]+)/gu)) {
    const name = match[1]!.replace(/:+$/gu, "");
    const start = match.index;
    const end = start + name.length + 1;
    if (
      !/[a-z]/u.test(name) ||
      (editingAt !== undefined && start < editingAt && editingAt <= end)
    ) {
      continue;
    }
    let escapes = 0;
    for (let at = start - 1; at >= 0 && value[at] === "\\"; at--) {
      escapes++;
    }
    if (escapes % 2) {
      continue;
    }
    const lookup = name.toLowerCase().replaceAll("_", "-");
    const command =
      SLASH_COMMANDS.find(
        (item) => item.source === "skill" && item.skillReferenceable === true && item.name === name,
      ) ??
      SLASH_COMMANDS.find(
        (item) =>
          item.source === "skill" &&
          item.skillReferenceable === true &&
          item.name.replaceAll("_", "-") === lookup,
      );
    if (command) {
      references.push({ start, end, name: command.name, label: getSkillDisplayName(command) });
    }
  }
  if (!references.length) {
    return references;
  }
  const code = findMarkdownCodeRegions(value);
  return references.filter(
    ({ start }) => !code.some((region) => region.start <= start && start < region.end),
  );
}
