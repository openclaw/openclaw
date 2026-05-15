import { detectInlineEvalArgv } from "../command-analysis/risks.js";
import { parseEnvInvocationPrelude, resolveCarrierCommandArgv } from "../command-carriers.js";
import { explainShellCommand } from "../command-explainer/extract.js";
import type {
  CommandExplanation,
  CommandRisk,
  CommandShape,
  CommandStep,
} from "../command-explainer/types.js";
import {
  analyzeArgvCommand,
  isWindowsPlatform,
  resolveCommandResolutionFromArgv,
  resolvePlannedSegmentArgv,
  windowsEscapeArg,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import type { ExecAllowlistPinnedArgvToken } from "../exec-approvals.types.js";
import {
  extractBindableShellWrapperInlineCommand,
  normalizeExecutableToken,
  POSIX_SHELL_WRAPPERS,
} from "../exec-wrapper-resolution.js";
import { resolveExecWrapperTrustPlan } from "../exec-wrapper-trust-plan.js";
import {
  isPowerShellInlineFileCommandFlag,
  resolvePowerShellInlineCommandMatch,
} from "../shell-inline-command.js";
import type {
  CommandAuthorizationChainOperator,
  CommandAuthorizationContext,
  CommandAuthorizationInput,
  CommandAuthorizationPlan,
  CommandAuthorizationRelationship,
  CommandAuthorizationTree,
  CommandAuthorizationUnit,
  CommandDialect,
  CommandPromptOnlyReason,
  CommandUnanalyzableReason,
} from "./types.js";

type RenderAuthorizationShellCommandMode = "enforced" | "safe-bins";

type SegmentSatisfiedBy =
  | "allowlist"
  | "safeBins"
  | "inlineChain"
  | "skills"
  | "skillPrelude"
  | null;

type PlannedTree = {
  tree: CommandAuthorizationTree;
  units: CommandAuthorizationUnit[];
  nextUnitIndex: number;
};

type UnsupportedWrapper = {
  dialect: "windows-cmd" | "powershell";
  reason: CommandPromptOnlyReason;
};

const SEMANTICS_NEUTRAL_RENDER_WRAPPERS = new Set(["env", "nice"]);

export async function planCommandForAuthorization(
  input: CommandAuthorizationInput,
  context: CommandAuthorizationContext = {},
): Promise<CommandAuthorizationPlan> {
  if (input.dialect === "argv") {
    return planArgvCommand(input.argv, input.command, context);
  }
  if (input.dialect === "windows-cmd" || input.dialect === "powershell") {
    return planUnsupportedShellDialect(input.command, input.dialect);
  }
  return planPosixShellCommand(input.command, context);
}

export function createExecCommandAnalysisFromAuthorizationPlan(params: {
  plan: CommandAuthorizationPlan;
  tree?: CommandAuthorizationTree;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis | null {
  if (params.plan.kind === "unanalyzable") {
    return null;
  }
  const unitsById = new Map(params.plan.units.map((unit) => [unit.id, unit]));
  const units = collectAuthorizationTreeUnits(params.tree ?? params.plan.tree, unitsById);
  if (units.length === 0) {
    return null;
  }
  return {
    ok: true,
    segments: units.map(
      (unit): ExecCommandSegment => ({
        raw: unit.raw,
        argv: unit.argv,
        resolution: resolveCommandResolutionFromArgv(unit.argv, params.cwd, params.env),
      }),
    ),
  };
}

export function renderAuthorizationShellCommand(params: {
  plan: CommandAuthorizationPlan;
  segments: readonly ExecCommandSegment[];
  segmentPinnedArgvTokens?: readonly (ExecAllowlistPinnedArgvToken | null)[];
  segmentSatisfiedBy?: readonly SegmentSatisfiedBy[];
  platform?: string | null;
  mode: RenderAuthorizationShellCommandMode;
}): { ok: boolean; command?: string; reason?: string } {
  if (params.plan.kind === "unanalyzable") {
    return { ok: false, reason: "unanalyzable command" };
  }
  if (
    params.mode === "safe-bins" &&
    params.segmentSatisfiedBy !== undefined &&
    params.segmentSatisfiedBy.length !== params.segments.length
  ) {
    return { ok: false, reason: "segment metadata mismatch" };
  }
  if (
    params.segmentPinnedArgvTokens !== undefined &&
    params.segmentPinnedArgvTokens.length !== params.segments.length
  ) {
    return { ok: false, reason: "segment pinned token metadata mismatch" };
  }

  const unitsById = new Map(params.plan.units.map((unit) => [unit.id, unit]));
  const cursor = { index: 0 };
  const rendered = renderAuthorizationTree({
    tree: params.plan.tree,
    unitsById,
    segments: params.segments,
    segmentPinnedArgvTokens: params.segmentPinnedArgvTokens,
    segmentSatisfiedBy: params.segmentSatisfiedBy,
    platform: params.platform,
    mode: params.mode,
    cursor,
  });
  if (!rendered.ok) {
    return rendered;
  }
  if (cursor.index !== params.segments.length) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rendered.command };
}

function planArgvCommand(
  argvInput: readonly string[],
  command: string | undefined,
  context: CommandAuthorizationContext,
): CommandAuthorizationPlan {
  const source = command ?? argvInput.join(" ");
  const argv = [...argvInput];
  if (argv.length === 0 || (argv[0]?.trim() ?? "").length === 0) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }

  const unsupportedWrapper = classifyUnsupportedWrapper(argv);
  if (unsupportedWrapper) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv,
      relationship: "wrapper-inline",
      promptOnlyReasons: [unsupportedWrapper.reason],
    });
    return promptOnlyPlan(source, unsupportedWrapper.dialect, { kind: "unit", unitId: unit.id }, [
      unit,
    ]);
  }

  const analysis = analyzeArgvCommand({
    argv,
    cwd: context.cwd,
    env: context.env,
  });
  if (!analysis.ok) {
    return unanalyzablePlan(source, "argv", ["empty-argv"]);
  }
  return finalizePlannedTree(source, "argv", buildTreeFromSegments(analysis.segments, 0, "simple"));
}

function planUnsupportedShellDialect(
  command: string,
  dialect: "windows-cmd" | "powershell",
): CommandAuthorizationPlan {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, dialect, ["empty-command"]);
  }
  const reason: CommandPromptOnlyReason =
    dialect === "powershell" ? "unsupported-powershell-wrapper" : "unsupported-cmd-wrapper";
  const unit = createUnit({
    id: "unit-0",
    raw: source,
    argv: [],
    relationship: "wrapper-inline",
    promptOnlyReasons: [reason],
  });
  return promptOnlyPlan(command, dialect, { kind: "unit", unitId: unit.id }, [unit]);
}

async function planPosixShellCommand(
  command: string,
  _context: CommandAuthorizationContext,
): Promise<CommandAuthorizationPlan> {
  const source = command.trim();
  if (!source) {
    return unanalyzablePlan(command, "posix-shell", ["empty-command"]);
  }

  const explanation = await explainShellCommand(source);
  if (!explanation.ok) {
    return unanalyzablePlan(source, "posix-shell", ["malformed-shell"]);
  }

  const selectedSteps = selectPlanningSteps(explanation);
  const sourcePromptOnlyReasons =
    selectedSteps.length === 0
      ? promptOnlyReasonsFromExplanation(explanation)
      : uniquePromptOnlyReasons([
          ...promptOnlyReasonsFromUnsupportedRender(explanation),
          ...promptOnlyReasonsFromCommentBoundaries(explanation.risks, selectedSteps),
          ...promptOnlyReasonsFromRisksOutsideSelectedSteps(explanation.risks, selectedSteps),
        ]);
  if (selectedSteps.length === 0 && sourcePromptOnlyReasons.length > 0) {
    const unit = createUnit({
      id: "unit-0",
      raw: source,
      argv: [],
      relationship: "simple",
      promptOnlyReasons: sourcePromptOnlyReasons,
    });
    return promptOnlyPlan(source, "posix-shell", { kind: "unit", unitId: unit.id }, [unit]);
  }

  if (selectedSteps.length === 0) {
    return unanalyzablePlan(source, "posix-shell", ["empty-command"]);
  }

  const planned = buildTreeFromCommandSteps(source, selectedSteps, explanation.risks);
  return finalizePlannedTree(
    source,
    "posix-shell",
    sourcePromptOnlyReasons.length > 0
      ? applyPromptOnlyReasonsToPlannedTree(planned, sourcePromptOnlyReasons)
      : planned,
  );
}

function selectPlanningSteps(explanation: CommandExplanation): CommandStep[] {
  const selectedSteps: CommandStep[] = [];
  for (const step of explanation.topLevelCommands) {
    const wrapperPayloadSteps = explanation.nestedCommands.filter(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex),
    );
    const leafWrapperPayloadSteps = leafCommandSteps(wrapperPayloadSteps);
    if (shouldPlanWrapperPayload(step, leafWrapperPayloadSteps, explanation.risks)) {
      selectedSteps.push(...leafWrapperPayloadSteps);
      continue;
    }
    selectedSteps.push(step);
  }
  return selectedSteps;
}

function leafCommandSteps(steps: readonly CommandStep[]): CommandStep[] {
  return steps.filter(
    (step) =>
      !steps.some(
        (candidate) =>
          candidate !== step &&
          stepContainsSpan(step, candidate.span.startIndex, candidate.span.endIndex),
      ),
  );
}

function shouldPlanWrapperPayload(
  step: CommandStep,
  wrapperPayloadSteps: readonly CommandStep[],
  risks: readonly CommandRisk[],
): boolean {
  if (wrapperPayloadSteps.length === 0) {
    return false;
  }
  const hasShellWrapperRisk = risks.some(
    (risk) =>
      (risk.kind === "shell-wrapper" || risk.kind === "shell-wrapper-through-carrier") &&
      spansOverlap(step.span.startIndex, step.span.endIndex, risk),
  );
  if (!hasShellWrapperRisk) {
    return false;
  }
  if (hasLeadingVariableAssignment(step)) {
    return false;
  }
  if (hasDynamicWrapperPayloadArgument(step, wrapperPayloadSteps, risks)) {
    return false;
  }
  const trustPlan = resolveExecWrapperTrustPlan(step.argv);
  if (trustPlan.policyBlocked) {
    return false;
  }
  if (hasNonTransparentPosixShellWrapperOption(trustPlan.argv)) {
    return false;
  }
  const inlineCommand =
    extractBindableShellWrapperInlineCommand(step.argv) ?? trustPlan.shellInlineCommand;
  if (!inlineCommand || isDirectShellPositionalCarrierInvocation(inlineCommand)) {
    return false;
  }
  return !wrapperPayloadSteps.some((payloadStep) =>
    hasRelativeExecutableThroughWrapperPayloadArgv(payloadStep.argv),
  );
}

function hasNonTransparentPosixShellWrapperOption(argv: readonly string[]): boolean {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  const posixShellWrappers: ReadonlySet<string> = POSIX_SHELL_WRAPPERS;
  if (!posixShellWrappers.has(executable)) {
    return false;
  }

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      return false;
    }
    if (token === "-c" || token === "--command") {
      return false;
    }
    if (token.startsWith("-") || token.startsWith("+")) {
      return true;
    }
    return false;
  }
  return false;
}

type StepGroup = {
  steps: CommandStep[];
  relationship: CommandAuthorizationRelationship;
};

function buildTreeFromCommandSteps(
  source: string,
  inputSteps: readonly CommandStep[],
  risks: readonly CommandRisk[],
): PlannedTree {
  const steps = inputSteps.toSorted((left, right) => left.span.startIndex - right.span.startIndex);
  const groups: StepGroup[] = [];
  const operators: CommandAuthorizationChainOperator[] = [];
  let currentSteps: CommandStep[] = [];
  let currentRelationship: CommandAuthorizationRelationship = "simple";

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!step) {
      continue;
    }
    currentSteps.push(step);
    const nextStep = steps[index + 1];
    if (!nextStep) {
      continue;
    }
    const separator = separatorBetweenSteps(source, step, nextStep);
    if (separator === "pipe") {
      continue;
    }
    groups.push({ steps: currentSteps, relationship: currentRelationship });
    currentSteps = [];
    if (separator) {
      operators.push(separator);
      currentRelationship = relationshipForOperator(separator);
    } else {
      operators.push(";");
      currentRelationship = "sequence";
    }
  }

  if (currentSteps.length > 0) {
    groups.push({
      steps: currentSteps,
      relationship:
        currentRelationship === "simple" && currentSteps.length > 1
          ? "pipeline"
          : currentRelationship,
    });
  }

  const units: CommandAuthorizationUnit[] = [];
  const children: CommandAuthorizationTree[] = [];
  let nextUnitIndex = 0;
  for (const group of groups) {
    const plannedGroup = buildTreeFromStepGroup(group, risks, nextUnitIndex);
    units.push(...plannedGroup.units);
    children.push(plannedGroup.tree);
    nextUnitIndex = plannedGroup.nextUnitIndex;
  }

  if (operators.length > 0) {
    return {
      tree: { kind: "chain", operators, children },
      units,
      nextUnitIndex,
    };
  }

  return {
    tree: children[0] ?? { kind: "pipeline", children: [] },
    units,
    nextUnitIndex,
  };
}

function applyPromptOnlyReasonsToPlannedTree(
  planned: PlannedTree,
  reasons: readonly CommandPromptOnlyReason[],
): PlannedTree {
  const promptOnlyReasons = uniquePromptOnlyReasons(reasons);
  return {
    ...planned,
    units: planned.units.map((unit) => ({
      ...unit,
      allowlistEligible: false,
      allowAlwaysEligible: false,
      promptOnlyReasons: uniquePromptOnlyReasons([...unit.promptOnlyReasons, ...promptOnlyReasons]),
    })),
  };
}

function buildTreeFromStepGroup(
  group: StepGroup,
  risks: readonly CommandRisk[],
  startUnitIndex: number,
): PlannedTree {
  const units = group.steps.map((step, offset) =>
    createUnitFromStep(step, `unit-${startUnitIndex + offset}`, group.relationship, risks),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

type StepSeparator = "pipe" | CommandAuthorizationChainOperator;

function separatorBetweenSteps(
  source: string,
  left: CommandStep,
  right: CommandStep,
): StepSeparator | null {
  const separatorText = source.slice(left.span.endIndex, right.span.startIndex);
  for (let index = 0; index < separatorText.length; index += 1) {
    const current = separatorText[index];
    const next = separatorText[index + 1];
    if (current === "&" && next === "&") {
      return "&&";
    }
    if (current === "|" && next === "|") {
      return "||";
    }
    if (current === ";" || current === "\n") {
      return ";";
    }
    if (current === "|") {
      return "pipe";
    }
  }
  return null;
}

function buildTreeFromSegments(
  segments: readonly ExecCommandSegment[],
  startUnitIndex: number,
  relationship: CommandAuthorizationRelationship,
): PlannedTree {
  const units = segments.map((segment, offset) =>
    createUnitFromSegment(segment, `unit-${startUnitIndex + offset}`, relationship),
  );
  const children = units.map(
    (unit): CommandAuthorizationTree => ({ kind: "unit", unitId: unit.id }),
  );
  return {
    tree: children.length === 1 ? children[0] : { kind: "pipeline", children },
    units,
    nextUnitIndex: startUnitIndex + units.length,
  };
}

function collectAuthorizationTreeUnits(
  tree: CommandAuthorizationTree,
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>,
): CommandAuthorizationUnit[] {
  if (tree.kind === "unit") {
    const unit = unitsById.get(tree.unitId);
    return unit ? [unit] : [];
  }
  return tree.children.flatMap((child) => collectAuthorizationTreeUnits(child, unitsById));
}

type RenderedAuthorizationTree = { ok: true; command: string } | { ok: false; reason: string };

function renderAuthorizationTree(params: {
  tree: CommandAuthorizationTree;
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>;
  segments: readonly ExecCommandSegment[];
  segmentPinnedArgvTokens?: readonly (ExecAllowlistPinnedArgvToken | null)[];
  segmentSatisfiedBy?: readonly SegmentSatisfiedBy[];
  platform?: string | null;
  mode: RenderAuthorizationShellCommandMode;
  cursor: { index: number };
}): RenderedAuthorizationTree {
  if (params.tree.kind === "unit") {
    return renderAuthorizationUnit({
      unitId: params.tree.unitId,
      unitsById: params.unitsById,
      segments: params.segments,
      segmentPinnedArgvTokens: params.segmentPinnedArgvTokens,
      segmentSatisfiedBy: params.segmentSatisfiedBy,
      platform: params.platform,
      mode: params.mode,
      cursor: params.cursor,
    });
  }
  const renderedChildren: string[] = [];
  for (const child of params.tree.children) {
    const rendered = renderAuthorizationTree({ ...params, tree: child });
    if (!rendered.ok) {
      return rendered;
    }
    renderedChildren.push(rendered.command);
  }
  if (params.tree.kind === "pipeline") {
    return { ok: true, command: renderedChildren.join(" | ") };
  }

  const parts: string[] = [];
  for (const [index, child] of renderedChildren.entries()) {
    parts.push(child);
    const operator = params.tree.operators[index];
    if (operator) {
      parts.push(operator);
    }
  }
  return { ok: true, command: parts.join(" ") };
}

function renderAuthorizationUnit(params: {
  unitId: string;
  unitsById: ReadonlyMap<string, CommandAuthorizationUnit>;
  segments: readonly ExecCommandSegment[];
  segmentPinnedArgvTokens?: readonly (ExecAllowlistPinnedArgvToken | null)[];
  segmentSatisfiedBy?: readonly SegmentSatisfiedBy[];
  platform?: string | null;
  mode: RenderAuthorizationShellCommandMode;
  cursor: { index: number };
}): RenderedAuthorizationTree {
  const unit = params.unitsById.get(params.unitId);
  if (!unit) {
    return { ok: false, reason: "unit mapping failed" };
  }
  const segment = params.segments[params.cursor.index];
  const pinnedArgvToken = params.segmentPinnedArgvTokens?.[params.cursor.index];
  const satisfiedBy = params.segmentSatisfiedBy?.[params.cursor.index];
  params.cursor.index += 1;
  if (!segment) {
    return { ok: false, reason: "segment mapping failed" };
  }
  if (pinnedArgvToken) {
    return renderPinnedRawUnitArgvToken({
      unit,
      segment,
      pinnedArgvToken,
      platform: params.platform,
    });
  }
  if (params.mode === "safe-bins" && satisfiedBy !== "safeBins") {
    if (satisfiedBy === "allowlist") {
      return renderAllowlistPinnedRawUnit({ unit, segment, platform: params.platform });
    }
    if (satisfiedBy === "inlineChain") {
      return { ok: false, reason: "inline chain planner render unavailable" };
    }
    return { ok: true, command: unit.raw.trim() };
  }

  if (requiresLeadingWrapperPreservation(segment) && !canRenderWithoutLeadingWrappers(segment)) {
    return { ok: false, reason: "allowlist wrapper preservation unavailable" };
  }
  const argv = resolvePlannedSegmentArgv(segment);
  if (!argv) {
    return { ok: false, reason: "segment execution plan unavailable" };
  }
  const rendered = renderQuotedArgv(argv, params.platform);
  if (!rendered) {
    return { ok: false, reason: "unsafe windows token in argv" };
  }
  return { ok: true, command: rendered };
}

function renderAllowlistPinnedRawUnit(params: {
  unit: CommandAuthorizationUnit;
  segment: ExecCommandSegment;
  platform?: string | null;
}): RenderedAuthorizationTree {
  if (isWindowsPlatform(params.platform)) {
    return { ok: true, command: params.unit.raw.trim() };
  }
  const rawExecutable = params.unit.executable?.trim();
  if (!rawExecutable) {
    return { ok: false, reason: "allowlist executable unavailable" };
  }
  const raw = params.unit.raw.trim();
  const argv = resolvePlannedSegmentArgv(params.segment);
  const pinnedExecutable = argv?.[0]?.trim();
  if (!pinnedExecutable) {
    return { ok: false, reason: "allowlist pinned executable unavailable" };
  }
  const executionRaw = params.segment.resolution?.execution.rawExecutable?.trim();
  if (executionRaw && executionRaw !== rawExecutable) {
    const effectiveArgvStartIndex = resolveEffectiveArgvStartIndex(
      params.unit.argv,
      params.segment,
    );
    if (effectiveArgvStartIndex !== null && effectiveArgvStartIndex > 0) {
      if (!canRenderWithoutLeadingWrappers(params.segment)) {
        return { ok: false, reason: "allowlist wrapper preservation unavailable" };
      }
      const rendered = renderQuotedPlannedSegmentArgv(params.segment, params.platform);
      if (!rendered) {
        return { ok: false, reason: "allowlist wrapper argv render unavailable" };
      }
      return { ok: true, command: rendered };
    }
    const rendered = replaceSpannedShellArgvToken({
      raw,
      argv: params.unit.argv,
      argvSpans: params.unit.argvSpans,
      tokenIndex: effectiveArgvStartIndex,
      expectedToken: executionRaw,
      replacement: shellEscapeSingleArg(pinnedExecutable),
    });
    if (!rendered) {
      return { ok: false, reason: "allowlist wrapper raw executable replacement unavailable" };
    }
    return { ok: true, command: rendered };
  }
  const rendered = replaceLeadingShellToken(
    raw,
    rawExecutable,
    shellEscapeSingleArg(pinnedExecutable),
  );
  if (!rendered) {
    return { ok: false, reason: "allowlist executable replacement unavailable" };
  }
  return { ok: true, command: rendered };
}

function renderPinnedRawUnitArgvToken(params: {
  unit: CommandAuthorizationUnit;
  segment: ExecCommandSegment;
  pinnedArgvToken: ExecAllowlistPinnedArgvToken;
  platform?: string | null;
}): RenderedAuthorizationTree {
  if (isWindowsPlatform(params.platform)) {
    return { ok: true, command: params.unit.raw.trim() };
  }
  const expectedToken = params.unit.argv[params.pinnedArgvToken.tokenIndex];
  if (!expectedToken) {
    return { ok: false, reason: "allowlist pinned argv token unavailable" };
  }
  const effectiveArgvStartIndex = resolveEffectiveArgvStartIndex(params.unit.argv, params.segment);
  if (effectiveArgvStartIndex !== null && effectiveArgvStartIndex > 0) {
    if (!canRenderWithoutLeadingWrappers(params.segment)) {
      return { ok: false, reason: "allowlist wrapper preservation unavailable" };
    }
    const rendered = renderQuotedPlannedSegmentArgv(params.segment, params.platform, {
      tokenIndex: params.pinnedArgvToken.tokenIndex - effectiveArgvStartIndex,
      replacement: params.pinnedArgvToken.replacement,
    });
    if (!rendered) {
      return { ok: false, reason: "allowlist pinned wrapper argv render unavailable" };
    }
    return { ok: true, command: rendered };
  }
  let rendered = replaceSpannedShellArgvToken({
    raw: params.unit.raw.trim(),
    argv: params.unit.argv,
    argvSpans: params.unit.argvSpans,
    tokenIndex: params.pinnedArgvToken.tokenIndex,
    expectedToken,
    replacement: shellEscapeSingleArg(params.pinnedArgvToken.replacement),
  });
  if (!rendered) {
    return { ok: false, reason: "allowlist pinned argv token replacement unavailable" };
  }
  const executionRaw = params.segment.resolution?.execution.rawExecutable?.trim();
  const argv = resolvePlannedSegmentArgv(params.segment);
  const pinnedExecutable = argv?.[0]?.trim();
  if (executionRaw && pinnedExecutable) {
    const executablePinned = replaceSpannedShellArgvToken({
      raw: rendered,
      argv: params.unit.argv,
      argvSpans: params.unit.argvSpans,
      tokenIndex: resolveEffectiveArgvStartIndex(params.unit.argv, params.segment),
      expectedToken: executionRaw,
      replacement: shellEscapeSingleArg(pinnedExecutable),
    });
    if (!executablePinned) {
      return { ok: false, reason: "allowlist executable replacement unavailable" };
    }
    rendered = executablePinned;
  }
  return { ok: true, command: rendered };
}

function canRenderWithoutLeadingWrappers(segment: ExecCommandSegment): boolean {
  const wrapperChain = segment.resolution?.wrapperChain;
  return (
    Array.isArray(wrapperChain) &&
    wrapperChain.length > 0 &&
    wrapperChain.every((wrapper) => SEMANTICS_NEUTRAL_RENDER_WRAPPERS.has(wrapper))
  );
}

function requiresLeadingWrapperPreservation(segment: ExecCommandSegment): boolean {
  const effectiveArgvStartIndex = resolveEffectiveArgvStartIndex(segment.argv, segment);
  return effectiveArgvStartIndex !== null && effectiveArgvStartIndex > 0;
}

function renderQuotedPlannedSegmentArgv(
  segment: ExecCommandSegment,
  platform?: string | null,
  replacement?: { tokenIndex: number; replacement: string },
): string | null {
  const argv = resolvePlannedSegmentArgv(segment);
  if (!argv) {
    return null;
  }
  if (replacement) {
    if (replacement.tokenIndex < 0 || replacement.tokenIndex >= argv.length) {
      return null;
    }
    argv[replacement.tokenIndex] = replacement.replacement;
  }
  return renderQuotedArgv(argv, platform);
}

function resolveEffectiveArgvStartIndex(
  argv: readonly string[],
  segment: ExecCommandSegment,
): number | null {
  const effectiveArgv = segment.resolution?.effectiveArgv;
  if (!effectiveArgv || effectiveArgv.length === 0 || effectiveArgv.length > argv.length) {
    return null;
  }
  const startIndex = argv.length - effectiveArgv.length;
  for (let offset = 0; offset < effectiveArgv.length; offset += 1) {
    if (argv[startIndex + offset] !== effectiveArgv[offset]) {
      return null;
    }
  }
  return startIndex;
}

function replaceSpannedShellArgvToken(params: {
  raw: string;
  argv: readonly string[];
  argvSpans: CommandAuthorizationUnit["argvSpans"];
  tokenIndex: number | null;
  expectedToken: string;
  replacement: string;
}): string | null {
  if (
    params.tokenIndex === null ||
    !params.argvSpans ||
    params.argvSpans.length !== params.argv.length
  ) {
    return null;
  }
  if (params.argv[params.tokenIndex] !== params.expectedToken) {
    return null;
  }
  const span = params.argvSpans[params.tokenIndex];
  if (
    !span ||
    span.startIndex < 0 ||
    span.endIndex <= span.startIndex ||
    span.endIndex > params.raw.length
  ) {
    return null;
  }
  return `${params.raw.slice(0, span.startIndex)}${params.replacement}${params.raw.slice(
    span.endIndex,
  )}`;
}

function replaceLeadingShellToken(raw: string, token: string, replacement: string): string | null {
  const candidates = [
    token,
    shellEscapeSingleArg(token),
    `"${token.replace(/(["\\$`])/g, "\\$1")}"`,
  ];
  for (const candidate of candidates) {
    if (!raw.startsWith(candidate)) {
      continue;
    }
    const next = raw[candidate.length];
    if (next !== undefined && !/[\s;&|()<>]/u.test(next)) {
      continue;
    }
    return `${replacement}${raw.slice(candidate.length)}`;
  }
  return null;
}

function shellEscapeSingleArg(value: string): string {
  const singleQuoteEscape = `'"'"'`;
  return `'${value.replace(/'/g, singleQuoteEscape)}'`;
}

function renderQuotedArgv(argv: readonly string[], platform?: string | null): string | null {
  if (isWindowsPlatform(platform)) {
    const parts: string[] = [];
    for (const token of argv) {
      const result = windowsEscapeArg(token);
      if (!result.ok) {
        return null;
      }
      parts.push(result.escaped);
    }
    return parts.join(" ");
  }
  return argv.map((token) => shellEscapeSingleArg(token)).join(" ");
}

function createUnitFromSegment(
  segment: ExecCommandSegment,
  id: string,
  relationship: CommandAuthorizationRelationship,
): CommandAuthorizationUnit {
  const promptOnlyReasons: CommandPromptOnlyReason[] = [];
  if (detectInlineEvalArgv(segment.argv)) {
    promptOnlyReasons.push("interpreter-inline-eval");
  }
  return createUnit({
    id,
    raw: segment.raw,
    argv: segment.argv,
    relationship,
    promptOnlyReasons,
  });
}

function createUnitFromStep(
  step: CommandStep,
  id: string,
  relationship: CommandAuthorizationRelationship,
  risks: readonly CommandRisk[],
): CommandAuthorizationUnit {
  const promptOnlyReasons = promptOnlyReasonsForStep(step, risks);
  const unitRelationship =
    relationship === "simple" && step.context === "wrapper-payload"
      ? "wrapper-inline"
      : relationship;
  return createUnit({
    id,
    raw: step.text,
    argv: step.argv,
    argvSpans: relativeArgSpansForStep(step),
    relationship: unitRelationship,
    promptOnlyReasons,
  });
}

function createUnit(params: {
  id: string;
  raw: string;
  argv: string[];
  argvSpans?: CommandAuthorizationUnit["argvSpans"];
  relationship: CommandAuthorizationRelationship;
  promptOnlyReasons: CommandPromptOnlyReason[];
}): CommandAuthorizationUnit {
  const executable = params.argv[0]?.trim() || null;
  const normalizedExecutable = executable ? normalizeExecutableToken(executable) : null;
  const allowAutomatically = params.promptOnlyReasons.length === 0;
  return {
    id: params.id,
    raw: params.raw,
    argv: params.argv,
    ...(params.argvSpans ? { argvSpans: params.argvSpans } : {}),
    executable,
    normalizedExecutable,
    relationship: params.relationship,
    allowlistEligible: allowAutomatically,
    allowAlwaysEligible: allowAutomatically,
    promptOnlyReasons: params.promptOnlyReasons,
    blockReasons: [],
  };
}

function relativeArgSpansForStep(step: CommandStep): CommandAuthorizationUnit["argvSpans"] {
  if (!step.argvSpans || step.argvSpans.length !== step.argv.length) {
    return undefined;
  }
  return step.argvSpans.map((span) => ({
    startIndex: span.startIndex - step.span.startIndex,
    endIndex: span.endIndex - step.span.startIndex,
  }));
}

function finalizePlannedTree(
  source: string,
  dialect: CommandDialect,
  planned: PlannedTree,
): CommandAuthorizationPlan {
  const promptOnlyReasons = uniquePromptOnlyReasons(
    planned.units.flatMap((unit) => unit.promptOnlyReasons),
  );
  if (promptOnlyReasons.length > 0) {
    return promptOnlyPlan(source, dialect, planned.tree, planned.units);
  }
  return {
    kind: "analyzable",
    source,
    dialect,
    tree: planned.tree,
    units: planned.units,
  };
}

function promptOnlyPlan(
  source: string,
  dialect: CommandDialect,
  tree: CommandAuthorizationTree,
  units: CommandAuthorizationUnit[],
): CommandAuthorizationPlan {
  return {
    kind: "prompt-only",
    source,
    dialect,
    tree,
    units,
    promptOnlyReasons: uniquePromptOnlyReasons(units.flatMap((unit) => unit.promptOnlyReasons)),
  };
}

function unanalyzablePlan(
  source: string,
  dialect: CommandDialect,
  reasons: CommandUnanalyzableReason[],
): CommandAuthorizationPlan {
  return {
    kind: "unanalyzable",
    source,
    dialect,
    reasons,
  };
}

function relationshipForOperator(
  operator: CommandAuthorizationChainOperator | null,
): CommandAuthorizationRelationship {
  if (operator === "&&") {
    return "and-conditional";
  }
  if (operator === "||") {
    return "or-conditional";
  }
  if (operator === ";") {
    return "sequence";
  }
  return "simple";
}

function uniquePromptOnlyReasons(
  reasons: readonly CommandPromptOnlyReason[],
): CommandPromptOnlyReason[] {
  return [...new Set(reasons)];
}

function classifyUnsupportedWrapper(argv: readonly string[]): UnsupportedWrapper | null {
  const executable = normalizeExecutableToken(argv[0] ?? "");
  if (executable === "cmd" || executable === "cmd.exe") {
    return extractBindableShellWrapperInlineCommand([...argv])
      ? { dialect: "windows-cmd", reason: "unsupported-cmd-wrapper" }
      : null;
  }
  if (executable === "powershell" || executable === "powershell.exe" || executable === "pwsh") {
    const match = resolvePowerShellInlineCommandMatch([...argv]);
    const flag = match.valueTokenIndex === null ? null : argv[match.valueTokenIndex - 1];
    return match.valueTokenIndex !== null &&
      !isPowerShellInlineFileCommandFlag(typeof flag === "string" ? flag : "")
      ? { dialect: "powershell", reason: "unsupported-powershell-wrapper" }
      : null;
  }
  return null;
}

function promptOnlyReasonsForStep(
  step: CommandStep,
  risks: readonly CommandRisk[],
): CommandPromptOnlyReason[] {
  const unsupportedWrapper = classifyUnsupportedWrapper(step.argv);
  if (unsupportedWrapper) {
    return [unsupportedWrapper.reason];
  }
  const inlineCommand = extractBindableShellWrapperInlineCommand(step.argv);
  const stepRisks = risks.filter((risk) =>
    spansOverlap(step.span.startIndex, step.span.endIndex, risk),
  );
  if (inlineCommand && isDirectShellPositionalCarrierInvocation(inlineCommand)) {
    return promptOnlyReasonsForDirectShellPositionalCarrierStep({
      step,
      inlineCommand,
      risks: stepRisks,
    });
  }
  const reasons = promptOnlyReasonsFromRisks(stepRisks);
  if (hasLeadingVariableAssignment(step)) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasEnvMutationShellWrapperCarrier(step)) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

function promptOnlyReasonsForDirectShellPositionalCarrierStep(params: {
  step: CommandStep;
  inlineCommand: string;
  risks: readonly CommandRisk[];
}): CommandPromptOnlyReason[] {
  const outerRisks = params.risks.filter(
    (risk) =>
      risk.kind !== "inline-eval" &&
      !riskWithinShellInlinePayload(params.step, params.inlineCommand, risk),
  );
  const reasons = promptOnlyReasonsFromRisks(outerRisks);
  if (outerRisks.some((risk) => risk.kind === "dynamic-argument")) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasLeadingVariableAssignment(params.step)) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasEnvMutationShellWrapperCarrier(params.step)) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

function riskWithinShellInlinePayload(
  step: CommandStep,
  inlineCommand: string,
  risk: CommandRisk,
): boolean {
  const payloadOffset = step.text.indexOf(inlineCommand);
  if (payloadOffset < 0) {
    return false;
  }
  const payloadStart = step.span.startIndex + payloadOffset;
  const payloadEnd = payloadStart + inlineCommand.length;
  return risk.span.startIndex >= payloadStart && risk.span.endIndex <= payloadEnd;
}

function promptOnlyReasonsFromRisks(risks: readonly CommandRisk[]): CommandPromptOnlyReason[] {
  const reasonSet = new Set<CommandPromptOnlyReason>();
  for (const risk of risks) {
    if (risk.kind === "inline-eval") {
      reasonSet.add("interpreter-inline-eval");
    } else if (risk.kind === "command-substitution") {
      reasonSet.add("command-substitution");
    } else if (risk.kind === "dynamic-executable") {
      reasonSet.add("dynamic-executable");
    } else if (
      risk.kind === "alias" ||
      risk.kind === "eval" ||
      risk.kind === "source" ||
      risk.kind === "shell-state-mutation" ||
      risk.kind === "function-definition" ||
      risk.kind === "line-continuation" ||
      risk.kind === "process-substitution" ||
      risk.kind === "heredoc" ||
      risk.kind === "here-string" ||
      risk.kind === "redirect" ||
      risk.kind === "wrapper-payload-depth" ||
      risk.kind === "syntax-error"
    ) {
      reasonSet.add("unsupported-shell-syntax");
    }
  }
  return (
    [
      "command-substitution",
      "dynamic-executable",
      "interpreter-inline-eval",
      "unsupported-shell-syntax",
    ] as const
  ).filter((reason) => reasonSet.has(reason));
}

function promptOnlyReasonsFromRisksOutsideSelectedSteps(
  risks: readonly CommandRisk[],
  selectedSteps: readonly CommandStep[],
): CommandPromptOnlyReason[] {
  const skippedRisks = risks.filter(
    (risk) =>
      !selectedSteps.some((step) =>
        stepContainsSpan(step, risk.span.startIndex, risk.span.endIndex),
      ),
  );
  const reasons = promptOnlyReasonsFromRisks(skippedRisks);
  if (skippedRisks.some((risk) => risk.kind === "dynamic-argument")) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

const UNSUPPORTED_RENDER_SHAPES = new Set<CommandShape>([
  "stderr-pipeline",
  "negation",
  "if",
  "for",
  "while",
  "case",
  "subshell",
  "group",
  "background",
]);

function promptOnlyReasonsFromExplanation(
  explanation: CommandExplanation,
): CommandPromptOnlyReason[] {
  const reasons = promptOnlyReasonsFromRisks(explanation.risks);
  reasons.push(...promptOnlyReasonsFromUnsupportedRender(explanation));
  return uniquePromptOnlyReasons(reasons);
}

function promptOnlyReasonsFromUnsupportedRender(
  explanation: CommandExplanation,
): CommandPromptOnlyReason[] {
  const reasons: CommandPromptOnlyReason[] = [];
  if (
    explanation.risks.some(
      (risk) =>
        risk.kind === "heredoc" ||
        risk.kind === "here-string" ||
        risk.kind === "redirect" ||
        risk.kind === "alias" ||
        risk.kind === "eval" ||
        risk.kind === "source" ||
        risk.kind === "shell-state-mutation" ||
        risk.kind === "function-definition" ||
        risk.kind === "line-continuation" ||
        risk.kind === "process-substitution" ||
        risk.kind === "syntax-error",
    )
  ) {
    reasons.push("unsupported-shell-syntax");
  }
  if (explanation.shapes.some((shape) => UNSUPPORTED_RENDER_SHAPES.has(shape))) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasMixedWrapperPayloadGroupingRisk(explanation)) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasRelativeWrapperPayloadExecutable(explanation)) {
    reasons.push("unsupported-shell-syntax");
  }
  if (hasDynamicWrapperPayloadArgumentInExplanation(explanation)) {
    reasons.push("unsupported-shell-syntax");
  }
  return uniquePromptOnlyReasons(reasons);
}

function hasDynamicWrapperPayloadArgumentInExplanation(explanation: CommandExplanation): boolean {
  return explanation.topLevelCommands.some((step) => {
    const wrapperPayloadSteps = explanation.nestedCommands.filter(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex),
    );
    return hasDynamicWrapperPayloadArgument(step, wrapperPayloadSteps, explanation.risks);
  });
}

function hasDynamicWrapperPayloadArgument(
  step: CommandStep,
  wrapperPayloadSteps: readonly CommandStep[],
  risks: readonly CommandRisk[],
): boolean {
  if (wrapperPayloadSteps.length === 0) {
    return false;
  }
  const hasShellWrapperRisk = risks.some(
    (risk) =>
      (risk.kind === "shell-wrapper" || risk.kind === "shell-wrapper-through-carrier") &&
      spansOverlap(step.span.startIndex, step.span.endIndex, risk),
  );
  if (!hasShellWrapperRisk) {
    return false;
  }
  const trustPlan = resolveExecWrapperTrustPlan(step.argv);
  const inlineCommand =
    extractBindableShellWrapperInlineCommand(step.argv) ?? trustPlan.shellInlineCommand;
  if (inlineCommand && isDirectShellPositionalCarrierInvocation(inlineCommand)) {
    return false;
  }
  return risks.some(
    (risk) =>
      risk.kind === "dynamic-argument" &&
      wrapperPayloadSteps.some((payloadStep) =>
        stepContainsSpan(payloadStep, risk.span.startIndex, risk.span.endIndex),
      ),
  );
}

function hasRelativeWrapperPayloadExecutable(explanation: CommandExplanation): boolean {
  return explanation.topLevelCommands.some((step) => {
    const hasShellWrapperRisk = explanation.risks.some(
      (risk) =>
        (risk.kind === "shell-wrapper" || risk.kind === "shell-wrapper-through-carrier") &&
        spansOverlap(step.span.startIndex, step.span.endIndex, risk),
    );
    if (!hasShellWrapperRisk) {
      return false;
    }
    return explanation.nestedCommands.some(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex) &&
        hasRelativeExecutableThroughWrapperPayloadArgv(nestedStep.argv),
    );
  });
}

function promptOnlyReasonsFromCommentBoundaries(
  risks: readonly CommandRisk[],
  selectedSteps: readonly CommandStep[],
): CommandPromptOnlyReason[] {
  const steps = selectedSteps.toSorted(
    (left, right) => left.span.startIndex - right.span.startIndex,
  );
  for (let index = 0; index < steps.length - 1; index += 1) {
    const left = steps[index];
    const right = steps[index + 1];
    if (!left || !right) {
      continue;
    }
    if (
      risks.some(
        (risk) =>
          risk.kind === "comment" &&
          risk.span.startIndex >= left.span.endIndex &&
          risk.span.endIndex <= right.span.startIndex,
      )
    ) {
      return ["unsupported-shell-syntax"];
    }
  }
  return [];
}

function hasMixedWrapperPayloadGroupingRisk(explanation: CommandExplanation): boolean {
  if (explanation.topLevelCommands.length < 2) {
    return false;
  }
  return explanation.topLevelCommands.some((step) => {
    const wrapperPayloadSteps = explanation.nestedCommands.filter(
      (nestedStep) =>
        nestedStep.context === "wrapper-payload" &&
        stepContainsSpan(step, nestedStep.span.startIndex, nestedStep.span.endIndex),
    );
    return (
      wrapperPayloadSteps.length > 1 &&
      shouldPlanWrapperPayload(step, wrapperPayloadSteps, explanation.risks)
    );
  });
}

function spansOverlap(startIndex: number, endIndex: number, risk: CommandRisk): boolean {
  return risk.span.startIndex < endIndex && risk.span.endIndex > startIndex;
}

function hasLeadingVariableAssignment(step: CommandStep): boolean {
  const relativeExecutableStart = step.executableSpan.startIndex - step.span.startIndex;
  if (relativeExecutableStart <= 0) {
    return false;
  }
  const prefix = step.text.slice(0, relativeExecutableStart).trim();
  if (!prefix) {
    return false;
  }
  return /(?:^|[\s])[_A-Za-z][_A-Za-z0-9]*=/u.test(prefix);
}

function hasEnvMutationShellWrapperCarrier(step: CommandStep): boolean {
  const parsed = parseEnvInvocationPrelude(step.argv);
  if (!parsed?.usesModifiers) {
    return false;
  }
  const carriedArgv = parsed.splitArgv ?? step.argv.slice(parsed.commandIndex);
  return Boolean(extractBindableShellWrapperInlineCommand(carriedArgv));
}

function hasRelativeExecutableThroughWrapperPayloadArgv(
  argv: readonly string[],
  depth = 0,
): boolean {
  if (depth >= 4) {
    return true;
  }
  if (isRelativePathScopedExecutableToken(argv[0] ?? "")) {
    return true;
  }
  const carriedArgv = resolveCarrierCommandArgv([...argv], 0, { includeExec: true });
  if (carriedArgv && carriedArgv.length > 0) {
    return hasRelativeExecutableThroughWrapperPayloadArgv(carriedArgv, depth + 1);
  }
  const trustPlan = resolveExecWrapperTrustPlan([...argv]);
  if (
    !trustPlan.policyBlocked &&
    trustPlan.argv.length > 0 &&
    !argvListsEqual(trustPlan.argv, argv)
  ) {
    return hasRelativeExecutableThroughWrapperPayloadArgv(trustPlan.argv, depth + 1);
  }
  return false;
}

function argvListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stepContainsSpan(step: CommandStep, startIndex: number, endIndex: number): boolean {
  return step.span.startIndex <= startIndex && step.span.endIndex >= endIndex;
}

function isRelativePathScopedExecutableToken(token: string): boolean {
  if (!token.includes("/") && !token.includes("\\")) {
    return false;
  }
  const normalized = token.replace(/\\/g, "/");
  return (
    !normalized.startsWith("/") && !/^[A-Za-z]:\//u.test(normalized) && !normalized.startsWith("//")
  );
}

function isDirectShellPositionalCarrierInvocation(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const shellWhitespace = String.raw`[^\S\r\n]+`;
  const positionalZero = String.raw`(?:\$(?:0|\{0\})|"\$(?:0|\{0\})")`;
  const positionalArg = String.raw`(?:\$(?:[@*]|[1-9]|\{[@*1-9]\})|"\$(?:[@*]|[1-9]|\{[@*1-9]\})")`;
  return new RegExp(
    `^(?:exec${shellWhitespace}(?:--${shellWhitespace})?)?${positionalZero}(?:${shellWhitespace}${positionalArg})*$`,
    "u",
  ).test(trimmed);
}
