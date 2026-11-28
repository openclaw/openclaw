import { findMarkdownCodeRegions } from "../../../../packages/markdown-core/src/markdown-code-regions.js";
import { listen } from "../reactive/listener.ts";
import { getSkillDisplayName, SLASH_COMMANDS, subscribeSlashCommands } from "./commands.ts";

export { subscribeSlashCommands } from "./commands.ts";

const skillToken = /\$([-a-zA-Z0-9_:]*)/gu;
const lowerCase = /[a-z]/u;

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
  for (const match of value.matchAll(skillToken)) {
    const name = match[1]!.replace(/:+$/gu, "");
    const start = match.index;
    const end = start + name.length + 1;
    if (
      !lowerCase.test(name) ||
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

/** Native drafts need only prove absence. Leave any possible reference (even an
 * unknown name) to the parser, since the caret or catalog may admit it later. */
export function createNativeSkillProbe(
  node: HTMLTextAreaElement,
  requestActivation: () => void,
  signal: AbortSignal,
) {
  const dispose = subscribeSlashCommands(requestActivation);
  listen(node, "selectionchange", requestActivation, { signal });
  let inspected: string | undefined;
  let literalEnd: number | undefined;
  let insertion: { data: string; start: number; end: number } | undefined;

  function mightHaveReferences() {
    const value = node.value;
    if (value !== inspected) {
      inspected = value;
      insertion = undefined;
      literalEnd = -1;
      for (const match of value.matchAll(skillToken)) {
        if (lowerCase.test(match[1]!)) {
          literalEnd = undefined;
          break;
        }
        literalEnd = match.index + match[0].length;
      }
    }
    return literalEnd === undefined;
  }

  return {
    dispose,
    hasReferences(editingValue?: string) {
      return (
        mightHaveReferences() &&
        readComposerSkillReferences(
          node.value,
          editingValue === node.value ? node.selectionStart : undefined,
        ).length > 0
      );
    },
    beforeInput(event: InputEvent) {
      const { data } = event;
      const start = node.selectionStart;
      // The delimiter immediately after the last token must survive the edit.
      insertion =
        event.isTrusted &&
        !event.isComposing &&
        event.inputType === "insertText" &&
        data &&
        !data.includes("$") &&
        literalEnd !== undefined &&
        start > literalEnd &&
        node.value === inspected
          ? {
              data,
              start,
              end: node.selectionEnd,
            }
          : undefined;
    },
    input(event: InputEvent) {
      const value = node.value;
      if (
        insertion &&
        inspected !== undefined &&
        event.isTrusted &&
        !event.isComposing &&
        event.inputType === "insertText" &&
        event.data === insertion.data &&
        value.length ===
          inspected.length + insertion.start - insertion.end + insertion.data.length &&
        node.selectionStart === insertion.start + insertion.data.length &&
        // A later beforeinput listener can rewrite the draft without changing its length.
        value.startsWith(inspected.slice(0, insertion.start)) &&
        value.startsWith(insertion.data, insertion.start) &&
        value.endsWith(inspected.slice(insertion.end))
      ) {
        inspected = value;
      }
      insertion = undefined;
    },
  };
}
