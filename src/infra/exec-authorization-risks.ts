// Classifies command-explainer risks into exec authorization outcomes: prompt-only,
// non-reusable, or unanalyzable plans that fall back to the whole command.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { CommandExplanation, CommandRisk, CommandStep } from "./command-explainer/types.js";

const PROMPT_ONLY_RISKS = new Set<CommandRisk["kind"]>([
  "eval",
  "source",
  "alias",
  "shell-wrapper-through-carrier",
  "command-carrier",
]);
export const NON_REUSABLE_RISKS = new Set<CommandRisk["kind"]>(["inline-eval"]);

const UNANALYZABLE_RISKS = new Set<CommandRisk["kind"]>([
  "command-substitution",
  "dynamic-executable",
  "dynamic-assignment",
  "line-continuation",
  "heredoc",
  "here-string",
  "process-substitution",
  "redirect",
  "syntax-error",
  "function-definition",
]);

const UNSUPPORTED_DIRECT_SHELL_TOPOLOGY_SHAPES = new Set<CommandExplanation["shapes"][number]>([
  "background",
  "if",
  "for",
  "while",
  "case",
  "subshell",
  "group",
]);

export function riskInsideStep(risk: CommandRisk, step: CommandStep): boolean {
  return risk.span.startIndex >= step.span.startIndex && risk.span.endIndex <= step.span.endIndex;
}

function riskBeforeStepExecutable(risk: CommandRisk, step: CommandStep): boolean {
  return riskInsideStep(risk, step) && risk.span.endIndex <= step.executableSpan.startIndex;
}

export function stepReasons(
  step: CommandStep,
  risks: readonly CommandRisk[],
  kinds: ReadonlySet<CommandRisk["kind"]> = PROMPT_ONLY_RISKS,
): string[] {
  const reasons: string[] = [];
  for (const risk of risks) {
    if (kinds.has(risk.kind) && riskInsideStep(risk, step)) {
      reasons.push(risk.kind);
    }
  }
  return uniqueStrings(reasons);
}

// `$[...]` is legacy Bash arithmetic: like `$((...))`, it re-evaluates its decoded text, so
// array subscripts built from ANSI-C escapes can run command substitution.
function isShellExpansionDynamicArgument(risk: CommandRisk): boolean {
  return (
    risk.kind === "dynamic-argument" &&
    /(?:\$[A-Za-z0-9_@*?#$!-]|\$\{|`|\$\(|\$\[|[<>]\()/u.test(risk.text)
  );
}

function riskInsidePromptOnlyStep(risk: CommandRisk, explanation: CommandExplanation): boolean {
  return [...explanation.topLevelCommands, ...explanation.nestedCommands].some(
    (step) => riskInsideStep(risk, step) && stepReasons(step, explanation.risks).length > 0,
  );
}

export function findUnanalyzableRisk(explanation: CommandExplanation): CommandRisk | null {
  return explanation.risks.find((entry) => UNANALYZABLE_RISKS.has(entry.kind)) ?? null;
}

export function hasBlockingRisk(
  explanation: CommandExplanation,
): CommandRisk["kind"] | CommandExplanation["shapes"][number] | null {
  const risk = findUnanalyzableRisk(explanation);
  if (risk) {
    return risk.kind;
  }
  const unsupportedShape = explanation.shapes.find((shape) =>
    UNSUPPORTED_DIRECT_SHELL_TOPOLOGY_SHAPES.has(shape),
  );
  if (unsupportedShape) {
    return unsupportedShape;
  }
  const dynamicArgument = explanation.risks.find(
    (entry) =>
      isShellExpansionDynamicArgument(entry) && !riskInsidePromptOnlyStep(entry, explanation),
  );
  if (dynamicArgument) {
    return dynamicArgument.kind;
  }
  return null;
}

export function shellWrapperPreludeReasons(params: {
  step: CommandStep;
  risks: readonly CommandRisk[];
}): string[] {
  const reasons = params.risks
    .filter(
      (risk) => UNANALYZABLE_RISKS.has(risk.kind) && riskBeforeStepExecutable(risk, params.step),
    )
    .map((risk) => risk.kind);
  return uniqueStrings(reasons);
}
