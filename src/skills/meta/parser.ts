import {
  META_STEP_KINDS,
  type MetaFailureAttempt,
  type MetaFailurePolicy,
  type MetaFinalTextMode,
  type MetaPlan,
  type MetaRouteCases,
  type MetaStep,
  type MetaStepKind,
  type MetaTrigger,
  type MetaWhenExpression,
} from "./types.js";

const META_OUTPUT_PATH_PATTERN = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;

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

function asNonEmptyStringArray(value: unknown, label: string): string[] {
  const entries = asStringArray(value, label);
  if (entries.length === 0) {
    throw new Error(`${label} must be a non-empty array of strings`);
  }
  return entries;
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

function asPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseFailureAttempt(value: unknown, index: number): MetaFailureAttempt {
  const record = asRecord(value, `on_failure.attempts.${index}`);
  return {
    ...(record.prompt === undefined
      ? {}
      : { prompt: asPresentString(record.prompt, `on_failure.attempts.${index}.prompt`) }),
    ...(record.tool === undefined
      ? {}
      : { toolName: asPresentString(record.tool, `on_failure.attempts.${index}.tool`) }),
    ...(record.skill === undefined
      ? {}
      : { skillName: asPresentString(record.skill, `on_failure.attempts.${index}.skill`) }),
    ...(record.args === undefined
      ? {}
      : { args: asPresentRecord(record.args, `on_failure.attempts.${index}.args`) }),
    ...(record.choices === undefined
      ? {}
      : { choices: asStringArray(record.choices, `on_failure.attempts.${index}.choices`) }),
    ...(record.schema === undefined
      ? {}
      : { schema: asPresentRecord(record.schema, `on_failure.attempts.${index}.schema`) }),
  };
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
  if (record.kind === "failover") {
    if (!Array.isArray(record.attempts) || record.attempts.length === 0) {
      throw new Error("on_failure.attempts must be a non-empty array");
    }
    const attempts = record.attempts.map((entry, index) => parseFailureAttempt(entry, index));
    const maxAttempts =
      record.max_attempts === undefined
        ? attempts.length
        : asPositiveInteger(record.max_attempts, "on_failure.max_attempts");
    if (maxAttempts > attempts.length) {
      throw new Error("on_failure.max_attempts cannot exceed on_failure.attempts length");
    }
    return {
      kind: "failover",
      attempts,
      maxAttempts,
    };
  }
  throw new Error(`Unsupported on_failure policy: ${String(record.kind)}`);
}

function normalizeOutputPath(value: unknown, label: string): string {
  const trimmed = asString(value, label);
  const unwrapped = trimmed.match(/^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/)?.[1] ?? trimmed;
  if (!META_OUTPUT_PATH_PATTERN.test(unwrapped)) {
    throw new Error(`${label} must be a dotted output path`);
  }
  return unwrapped;
}

function isJsonCompatibleValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) {
    return value.every(isJsonCompatibleValue);
  }
  if (value && typeof value === "object") {
    return Object.getPrototypeOf(value) === Object.prototype
      ? Object.values(value).every(isJsonCompatibleValue)
      : false;
  }
  return false;
}

function asJsonCompatibleValue(value: unknown, label: string): unknown {
  if (!isJsonCompatibleValue(value)) {
    throw new Error(`${label} must be JSON-compatible`);
  }
  return value;
}

function asJsonCompatibleRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value, label);
  if (!isJsonCompatibleValue(record)) {
    throw new Error(`${label} must be JSON-compatible`);
  }
  return record;
}

function parseRiskMetadata(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = raw.risk_metadata ?? raw.risk;
  if (value === undefined) {
    return undefined;
  }
  return asJsonCompatibleRecord(value, "risk metadata");
}

function parseWhenExpression(value: unknown, stepId: string): MetaWhenExpression | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return {
      kind: "truthy",
      path: normalizeOutputPath(value, `step ${stepId} when`),
    };
  }

  const record = asRecord(value, `step ${stepId} when`);
  const path = normalizeOutputPath(record.path, `step ${stepId} when.path`);
  const operators = [
    record.equals !== undefined ? "equals" : undefined,
    record.not_equals !== undefined ? "not_equals" : undefined,
    record.in !== undefined ? "in" : undefined,
  ].filter(Boolean);
  if (operators.length !== 1) {
    throw new Error(`step ${stepId} when must declare exactly one operator`);
  }
  if (record.equals !== undefined) {
    return {
      kind: "equals",
      path,
      value: asJsonCompatibleValue(record.equals, `step ${stepId} when.equals`),
    };
  }
  if (record.not_equals !== undefined) {
    return {
      kind: "not_equals",
      path,
      value: asJsonCompatibleValue(record.not_equals, `step ${stepId} when.not_equals`),
    };
  }
  if (!Array.isArray(record.in)) {
    throw new Error(`step ${stepId} when.in must be an array`);
  }
  return {
    kind: "in",
    path,
    values: record.in.map((entry) => asJsonCompatibleValue(entry, `step ${stepId} when.in`)),
  };
}

function parseRouteCases(value: unknown, stepId: string): MetaRouteCases | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, `step ${stepId} route`);
  const casesRecord = asRecord(record.cases, `step ${stepId} route.cases`);
  const cases: Record<string, string[]> = {};
  for (const [caseName, rawTargets] of Object.entries(casesRecord)) {
    const normalizedCase = asString(caseName, `step ${stepId} route case`);
    cases[normalizedCase] = asNonEmptyStringArray(
      rawTargets,
      `step ${stepId} route.cases.${normalizedCase}`,
    );
  }
  if (Object.keys(cases).length === 0) {
    throw new Error(`step ${stepId} route.cases must contain at least one case`);
  }
  return {
    path: normalizeOutputPath(record.path, `step ${stepId} route.path`),
    cases,
    ...(record.default === undefined
      ? {}
      : {
          default: asNonEmptyStringArray(record.default, `step ${stepId} route.default`),
        }),
  };
}

function validateStepKindFields(step: MetaStep): void {
  if (step.kind === "llm_classify" && (!step.choices || step.choices.length === 0)) {
    throw new Error(`step ${step.id} llm_classify requires non-empty choices`);
  }
  if (step.kind === "agent") {
    const sessionKey = step.args?.sessionKey;
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      throw new Error(`step ${step.id} agent requires args.sessionKey`);
    }
  }
  if (step.kind === "tool_call" && !step.toolName) {
    throw new Error(`step ${step.id} tool_call requires tool`);
  }
  if (step.kind === "skill_exec" && !step.skillName) {
    throw new Error(`step ${step.id} skill_exec requires skill`);
  }
}

function parseStep(value: unknown): MetaStep {
  const record = asRecord(value, "composition step");
  const id = asString(record.id, "step id");
  const kindValue = asString(record.kind, `step ${id} kind`);
  if (!isMetaStepKind(kindValue)) {
    throw new Error(`Unsupported meta step kind: ${kindValue}`);
  }
  const step: MetaStep = {
    id,
    kind: kindValue,
    dependsOn: asStringArray(record.depends_on, `step ${id} depends_on`),
    prompt: asPresentString(record.prompt, `step ${id} prompt`),
    toolName: asPresentString(record.tool, `step ${id} tool`),
    skillName: asPresentString(record.skill, `step ${id} skill`),
    args: asPresentRecord(record.args, `step ${id} args`),
    choices: asStringArray(record.choices, `step ${id} choices`),
    schema: asPresentRecord(record.schema, `step ${id} schema`),
    when: parseWhenExpression(record.when, id),
    route: parseRouteCases(record.route, id),
    onFailure: parseFailurePolicy(record.on_failure),
  };
  validateStepKindFields(step);
  return step;
}

function collectRouteTargetIds(route: MetaRouteCases): string[] {
  return [...Object.values(route.cases).flat(), ...(route.default ?? [])];
}

function stepDependsOn(
  step: MetaStep,
  dependencyId: string,
  byId: ReadonlyMap<string, MetaStep>,
  seen = new Set<string>(),
): boolean {
  if (step.dependsOn.includes(dependencyId)) {
    return true;
  }
  for (const parentId of step.dependsOn) {
    if (seen.has(parentId)) {
      continue;
    }
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent && stepDependsOn(parent, dependencyId, byId, seen)) {
      return true;
    }
  }
  return false;
}

function validateRouteTargets(steps: MetaStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (!step.route) {
      continue;
    }
    for (const targetId of collectRouteTargetIds(step.route)) {
      const target = byId.get(targetId);
      if (!target) {
        throw new Error(`step ${step.id} route references unknown step ${targetId}`);
      }
      if (targetId === step.id) {
        throw new Error(`step ${step.id} route cannot target itself`);
      }
      if (!stepDependsOn(target, step.id, byId)) {
        throw new Error(`step ${step.id} route target ${targetId} must depend on ${step.id}`);
      }
    }
  }
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
  validateRouteTargets(steps);
  const finalTextMode = parseFinalTextMode(raw.final_text_mode);
  if (finalTextMode.kind === "step" && !steps.some((step) => step.id === finalTextMode.stepId)) {
    throw new Error(`final_text_mode references unknown step ${finalTextMode.stepId}`);
  }

  const riskMetadata = parseRiskMetadata(raw);
  return {
    name: asString(raw.name, "name"),
    description: asString(raw.description, "description"),
    triggers: parseTriggers(raw.triggers),
    ...(riskMetadata ? { riskMetadata } : {}),
    steps,
    finalTextMode,
    ...(sourceFilePath ? { sourceFilePath } : {}),
  };
}
