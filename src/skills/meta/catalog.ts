import { formatErrorMessage } from "../../infra/errors.js";
import type { SkillEntry } from "../types.js";
import { decodeMetaFrontmatter } from "./frontmatter.js";
import { parseMetaPlan } from "./parser.js";
import { META_BLOCKED_TOOL_CALL_TARGET_NAMES } from "./types.js";
import type { MetaDiagnostic, MetaPlan, MetaStep } from "./types.js";

export type MetaSkillCatalog = {
  plans: MetaPlan[];
  diagnostics: MetaDiagnostic[];
};

export type MetaTriggerMatchKind = "deterministic" | "soft";

export type MetaTriggerMatch = {
  kind: MetaTriggerMatchKind;
  plan: MetaPlan;
  trigger: string;
};

export type BuildMetaSkillCatalogOptions = {
  availableToolNames?: readonly string[];
};

const BLOCKED_TOOL_CALL_TARGET_NAMES = new Set<string>(META_BLOCKED_TOOL_CALL_TARGET_NAMES);

function validateToolCallReference(
  step: MetaStep,
  availableToolNames: ReadonlySet<string> | undefined,
): void {
  if (step.kind !== "tool_call") {
    return;
  }
  const toolName = step.toolName;
  if (!toolName) {
    return;
  }
  if (BLOCKED_TOOL_CALL_TARGET_NAMES.has(toolName)) {
    throw new Error(`step ${step.id} tool_call target ${toolName} is not allowed`);
  }
  if (availableToolNames && !availableToolNames.has(toolName)) {
    throw new Error(`step ${step.id} tool_call references unavailable tool ${toolName}`);
  }
}

function validateSkillExecReference(
  step: MetaStep,
  skillEntriesByName: ReadonlyMap<string, SkillEntry>,
): void {
  if (step.kind !== "skill_exec") {
    return;
  }
  const skillName = step.skillName;
  if (!skillName) {
    return;
  }
  const target = skillEntriesByName.get(skillName);
  if (!target) {
    throw new Error(`step ${step.id} skill_exec references unavailable skill ${skillName}`);
  }
  if (target.frontmatter.kind === "meta") {
    throw new Error(`step ${step.id} skill_exec target ${skillName} must be an ordinary skill`);
  }
  if (target.skill.disableModelInvocation) {
    throw new Error(`step ${step.id} skill_exec target ${skillName} disables model invocation`);
  }
}

function validateMetaPlanReferences(
  plan: MetaPlan,
  params: {
    skillEntriesByName: ReadonlyMap<string, SkillEntry>;
    availableToolNames?: ReadonlySet<string>;
  },
): void {
  for (const step of plan.steps) {
    validateToolCallReference(step, params.availableToolNames);
    validateSkillExecReference(step, params.skillEntriesByName);
  }
}

export function buildMetaSkillCatalog(
  entries: readonly SkillEntry[] | undefined,
  options: BuildMetaSkillCatalogOptions = {},
): MetaSkillCatalog {
  const plans: MetaPlan[] = [];
  const diagnostics: MetaDiagnostic[] = [];
  const skillEntriesByName = new Map((entries ?? []).map((entry) => [entry.skill.name, entry]));
  const availableToolNames = options.availableToolNames
    ? new Set(options.availableToolNames)
    : undefined;

  for (const entry of entries ?? []) {
    if (entry.frontmatter.kind !== "meta") {
      continue;
    }

    try {
      const plan = parseMetaPlan(decodeMetaFrontmatter(entry.frontmatter), entry.skill.filePath);
      validateMetaPlanReferences(plan, {
        skillEntriesByName,
        availableToolNames,
      });
      plans.push(plan);
    } catch (error) {
      diagnostics.push({
        skillName: entry.skill.name,
        filePath: entry.skill.filePath,
        message: formatErrorMessage(error),
      });
    }
  }

  return {
    plans: plans.toSorted((left, right) => left.name.localeCompare(right.name, "en")),
    diagnostics: diagnostics.toSorted((left, right) =>
      left.skillName.localeCompare(right.skillName, "en"),
    ),
  };
}

export function findMetaPlanByName(catalog: MetaSkillCatalog, name: string): MetaPlan | undefined {
  return catalog.plans.find((plan) => plan.name === name);
}

function normalizeTriggerText(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function isDeterministicTriggerMatch(input: string, trigger: string): boolean {
  if (!input || !trigger) {
    return false;
  }
  if (input === trigger) {
    return true;
  }
  return trigger.startsWith("/") && input.startsWith(`${trigger} `);
}

function isSoftTriggerMatch(input: string, trigger: string): boolean {
  return Boolean(input && trigger && input.includes(trigger));
}

export function findMetaTriggerMatches(
  catalog: MetaSkillCatalog,
  inputText: string,
): MetaTriggerMatch[] {
  const input = normalizeTriggerText(inputText);
  const matches: MetaTriggerMatch[] = [];
  for (const plan of catalog.plans) {
    for (const trigger of plan.triggers) {
      const normalizedTrigger = normalizeTriggerText(trigger.pattern);
      if (isDeterministicTriggerMatch(input, normalizedTrigger)) {
        matches.push({
          kind: "deterministic",
          plan,
          trigger: trigger.pattern,
        });
        continue;
      }
      if (isSoftTriggerMatch(input, normalizedTrigger)) {
        matches.push({
          kind: "soft",
          plan,
          trigger: trigger.pattern,
        });
      }
    }
  }
  return matches;
}

export function findDeterministicMetaTriggerMatch(
  catalog: MetaSkillCatalog,
  inputText: string,
): MetaTriggerMatch | undefined {
  const deterministicMatches = findMetaTriggerMatches(catalog, inputText).filter(
    (match) => match.kind === "deterministic",
  );
  if (deterministicMatches.length !== 1) {
    return undefined;
  }
  return deterministicMatches[0];
}
