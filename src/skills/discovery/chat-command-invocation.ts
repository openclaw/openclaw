import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { getChatCommands } from "../../auto-reply/commands-registry.data.js";
import type { ExplicitSkillSelection, SkillCommandSpec } from "../types.js";

const MAX_EXPLICIT_SKILL_REFERENCES = 8;
const MAX_EXPLICIT_SKILL_REFERENCE_CHARS = 512;
const MAX_EXPLICIT_SKILL_INSTRUCTION_CHARS = 1_000;

export function skillCommandsToExplicitSelections(
  skills: readonly SkillCommandSpec[],
): ExplicitSkillSelection[] {
  return skills.flatMap((skill) =>
    skill.skillFile ? [{ name: skill.name, path: skill.skillFile }] : [],
  );
}

export function mergeExplicitSkillSelections(
  ...groups: ReadonlyArray<readonly ExplicitSkillSelection[] | undefined>
): ExplicitSkillSelection[] | undefined {
  const merged = new Map<string, ExplicitSkillSelection>();
  for (const selection of groups.flatMap((group) => group ?? [])) {
    merged.set(`${selection.name}\0${selection.path}`, selection);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}

/** Lists slash command names reserved by built-in chat commands and callers. */
export function listReservedChatSlashCommandNames(extraNames: string[] = []): Set<string> {
  const reserved = new Set<string>();
  for (const command of getChatCommands()) {
    if (command.nativeName) {
      reserved.add(normalizeOptionalLowercaseString(command.nativeName) ?? "");
    }
    for (const alias of command.textAliases) {
      const trimmed = alias.trim();
      if (!trimmed.startsWith("/")) {
        continue;
      }
      reserved.add(normalizeLowercaseStringOrEmpty(trimmed.slice(1)));
    }
  }
  for (const name of extraNames) {
    const trimmed = normalizeOptionalLowercaseString(name);
    if (trimmed) {
      reserved.add(trimmed);
    }
  }
  return reserved;
}

// Skill commands allow spaces/underscores in names but compare through dash-normalized lookup.
function normalizeSkillCommandLookup(value: string): string {
  return (normalizeOptionalLowercaseString(value) ?? "").replace(/[\s_]+/g, "-");
}

function findSkillCommand(
  skillCommands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeOptionalLowercaseString(trimmed) ?? "";
  const normalized = normalizeSkillCommandLookup(trimmed);
  return skillCommands.find(
    (entry) =>
      normalizeOptionalLowercaseString(entry.name) === lowered ||
      normalizeOptionalLowercaseString(entry.skillName) === lowered ||
      normalizeSkillCommandLookup(entry.name) === normalized ||
      normalizeSkillCommandLookup(entry.skillName) === normalized,
  );
}

function isEscapedReference(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function* skillReferenceNames(text: string): IterableIterator<string> {
  for (const match of text.matchAll(/\$([-a-zA-Z0-9_:]+)/gu)) {
    const name = match[1]?.replace(/:+$/gu, "");
    const index = match.index;
    if (name && index !== undefined && !isEscapedReference(text, index) && /[a-z]/u.test(name)) {
      yield name;
    }
  }
}

/** Returns true when text may contain an explicit `$skill-name` reference. */
export function hasSkillReferenceCandidate(text: string): boolean {
  return !skillReferenceNames(text).next().done;
}

export function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): { command: SkillCommandSpec; args?: string; inline?: boolean } | null {
  const match = params.commandBodyNormalized.trim().match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) {
    return null;
  }
  const commandName = normalizeOptionalLowercaseString(match[1]);
  const invocation =
    commandName === "skill" ? match[2]?.trim().match(/^([^\s]+)(?:\s+([\s\S]+))?$/) : match;
  if (!commandName || !invocation) {
    return null;
  }
  const command =
    commandName === "skill"
      ? findSkillCommand(params.skillCommands, invocation[1] ?? "")
      : params.skillCommands.find(
          (entry) => normalizeOptionalLowercaseString(entry.name) === commandName,
        );
  return command ? { command, args: invocation[2]?.trim() || undefined } : null;
}

export function expandBundleCommandPromptTemplate(template: string, args?: string): string {
  const normalizedArgs = args?.trim() ?? "";
  const rendered = template.includes("$ARGUMENTS")
    ? template.replaceAll("$ARGUMENTS", () => normalizedArgs)
    : template;
  if (!normalizedArgs || template.includes("$ARGUMENTS")) {
    return rendered.trim();
  }
  return `${rendered.trim()}\n\nUser input:\n${normalizedArgs}`;
}

/** Expands model-routed skill references while leaving unknown slash commands untouched. */
export function expandExplicitSkillReferences(params: {
  text: string;
  skillCommands: SkillCommandSpec[];
  allSkillCommands?: SkillCommandSpec[];
}): { body: string; error?: string; skills: SkillCommandSpec[] } {
  const leadingSlash = params.text.trimStart().startsWith("/");
  const leadingInvocation = leadingSlash
    ? resolveSkillCommandInvocation({
        commandBodyNormalized: params.text,
        skillCommands: params.skillCommands,
      })
    : null;
  if (leadingInvocation?.command.promptTemplate) {
    return {
      body: expandBundleCommandPromptTemplate(
        leadingInvocation.command.promptTemplate,
        leadingInvocation.args,
      ),
      skills: [leadingInvocation.command],
    };
  }
  const available: SkillCommandSpec[] = [];
  const allCommands = params.allSkillCommands ?? params.skillCommands;
  let unavailable: SkillCommandSpec | undefined;
  if (leadingSlash) {
    if (leadingInvocation) {
      available.push(leadingInvocation.command);
    } else if (allCommands !== params.skillCommands) {
      unavailable = resolveSkillCommandInvocation({
        commandBodyNormalized: params.text,
        skillCommands: allCommands,
      })?.command;
    }
  } else {
    const seen = new Set<string>();
    for (const name of skillReferenceNames(params.text)) {
      const command = findSkillCommand(params.skillCommands, name);
      if (command) {
        if (!command.promptTemplate && !seen.has(command.name)) {
          seen.add(command.name);
          available.push(command);
        }
      } else if (allCommands !== params.skillCommands) {
        unavailable = findSkillCommand(allCommands, name);
        if (unavailable) {
          break;
        }
      }
    }
  }
  const error = unavailable
    ? `Skill "${unavailable.skillName}" is not available for this agent. Update the skill allowlist or choose an allowed skill.`
    : available.length > MAX_EXPLICIT_SKILL_REFERENCES
      ? `Too many skill references. Use at most ${MAX_EXPLICIT_SKILL_REFERENCES} skills in one message.`
      : undefined;
  if (error) {
    return { body: params.text, error, skills: [] };
  }
  if (available.length === 0) {
    return { body: params.text, skills: [] };
  }
  const referenceLines = available.map((skill) =>
    skill.modelVisible === false && skill.skillFile
      ? `- ${skill.skillName} (SKILL.md: ${skill.skillFile})`
      : `- ${skill.skillName}`,
  );
  // The reference-count cap alone does not bound operator-provided names or paths.
  // Keep both each item and the complete injected prefix within fixed prompt budgets.
  if (referenceLines.some((line) => line.length > MAX_EXPLICIT_SKILL_REFERENCE_CHARS)) {
    return {
      body: params.text,
      error: `Skill reference metadata is too long. Keep each rendered reference at ${MAX_EXPLICIT_SKILL_REFERENCE_CHARS} characters or less.`,
      skills: [],
    };
  }
  const instructionPrefix = [
    "Use the following explicitly referenced skills for this request. Read each skill's SKILL.md before acting:",
    ...referenceLines,
    "",
    "User request:",
    "",
  ].join("\n");
  if (instructionPrefix.length > MAX_EXPLICIT_SKILL_INSTRUCTION_CHARS) {
    return {
      body: params.text,
      error:
        "Combined skill reference metadata is too long. Use fewer or shorter skill references.",
      skills: [],
    };
  }
  return {
    body: `${instructionPrefix}${params.text}`,
    skills: available,
  };
}
