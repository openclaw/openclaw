import {
  META_STEP_KINDS,
  type MetaFailurePolicy,
  type MetaFinalTextMode,
  type MetaPlan,
  type MetaStep,
  type MetaStepKind,
  type MetaTrigger,
} from "./types.js";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry) => entry.trim());
}

function asPresentString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, label);
}

function asPresentRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asRecord(value, label);
}

function isMetaStepKind(value: string): value is MetaStepKind {
  return META_STEP_KINDS.includes(value as MetaStepKind);
}

function parseTriggers(value: unknown): MetaTrigger[] {
  if (!Array.isArray(value)) {
    throw new Error("triggers must be an array");
  }
  return value.map((entry) => ({ pattern: asString(entry, "trigger") }));
}

function formatUnsupportedValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return `${value}`;
  }
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

function parseFinalTextMode(value: unknown): MetaFinalTextMode {
  if (value === undefined || value === "auto") {
    return { kind: "auto" };
  }
  if (value === "raw") {
    return { kind: "raw" };
  }
  if (typeof value === "string" && value.startsWith("step:")) {
    return {
      kind: "step",
      stepId: asString(value.slice("step:".length), "final_text_mode step id"),
    };
  }
  throw new Error(`Unsupported final_text_mode: ${formatUnsupportedValue(value)}`);
}

function parseFailurePolicy(value: unknown): MetaFailurePolicy {
  if (value === undefined || value === "fail") {
    return { kind: "fail" };
  }
  if (value === "skip") {
    return { kind: "skip" };
  }
  const record = asRecord(value, "on_failure");
  if (record.kind === "substitute") {
    return {
      kind: "substitute",
      output: asRecord(record.output, "on_failure.output"),
    };
  }
  throw new Error(`Unsupported on_failure policy: ${String(record.kind)}`);
}

function parseStep(value: unknown): MetaStep {
  const record = asRecord(value, "composition step");
  const id = asString(record.id, "step id");
  const kindValue = asString(record.kind, `step ${id} kind`);
  if (!isMetaStepKind(kindValue)) {
    throw new Error(`Unsupported meta step kind: ${kindValue}`);
  }
  return {
    id,
    kind: kindValue,
    dependsOn: asStringArray(record.depends_on, `step ${id} depends_on`),
    prompt: asPresentString(record.prompt, `step ${id} prompt`),
    toolName: asPresentString(record.tool, `step ${id} tool`),
    skillName: asPresentString(record.skill, `step ${id} skill`),
    args: asPresentRecord(record.args, `step ${id} args`),
    choices: asStringArray(record.choices, `step ${id} choices`),
    schema: asPresentRecord(record.schema, `step ${id} schema`),
    onFailure: parseFailurePolicy(record.on_failure),
  };
}

function sortTopologically(steps: MetaStep[]): MetaStep[] {
  const byId = new Map<string, MetaStep>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new Error(`Duplicate meta step id: ${step.id}`);
    }
    byId.set(step.id, step);
  }

  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (!byId.has(dependencyId)) {
        throw new Error(`Step ${step.id} depends on unknown step ${dependencyId}`);
      }
    }
  }

  const result: MetaStep[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (step: MetaStep): void => {
    if (visited.has(step.id)) {
      return;
    }
    if (visiting.has(step.id)) {
      throw new Error("Meta plan contains a dependency cycle");
    }

    visiting.add(step.id);
    for (const dependencyId of step.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Step ${step.id} depends on unknown step ${dependencyId}`);
      }
      visit(dependency);
    }
    visiting.delete(step.id);
    visited.add(step.id);
    result.push(step);
  };

  for (const step of steps) {
    visit(step);
  }

  return result;
}

export function parseMetaPlan(raw: Record<string, unknown>, sourceFilePath?: string): MetaPlan {
  if (raw.kind !== "meta") {
    throw new Error("Meta skill kind must be meta");
  }

  const composition = asRecord(raw.composition, "composition");
  const rawSteps = Array.isArray(composition.steps) ? composition.steps : undefined;
  if (!rawSteps || rawSteps.length === 0) {
    throw new Error("composition.steps must be a non-empty array");
  }

  const steps = sortTopologically(rawSteps.map((step) => parseStep(step)));
  const finalTextMode = parseFinalTextMode(raw.final_text_mode);
  if (finalTextMode.kind === "step" && !steps.some((step) => step.id === finalTextMode.stepId)) {
    throw new Error(`final_text_mode references unknown step ${finalTextMode.stepId}`);
  }

  return {
    name: asString(raw.name, "name"),
    description: asString(raw.description, "description"),
    triggers: parseTriggers(raw.triggers),
    steps,
    finalTextMode,
    ...(sourceFilePath ? { sourceFilePath } : {}),
  };
}
