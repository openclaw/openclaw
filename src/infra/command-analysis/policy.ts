import type {
  CommandExplanation,
  CommandRisk,
  CommandStep,
  SourceSpan,
} from "../command-explainer/types.js";
import {
  analyzeArgvCommand,
  analyzeShellCommand,
  isWindowsPlatform,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";
import type { InterpreterInlineEvalHit } from "./inline-eval.js";
import { detectInlineEvalInSegments } from "./risks.js";

export type CommandPolicyAnalysis =
  | {
      ok: true;
      source: "argv" | "shell";
      analysis: ExecCommandAnalysis;
      segments: ExecCommandSegment[];
    }
  | {
      ok: false;
      source: "argv" | "shell";
      reason?: string;
      analysis: ExecCommandAnalysis;
      segments: [];
    };

export async function analyzeCommandForPolicy(
  params:
    | {
        source: "shell";
        command: string;
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        platform?: string | null;
      }
    | {
        source: "argv";
        argv: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
      },
): Promise<CommandPolicyAnalysis> {
  const analysis =
    params.source === "shell"
      ? await analyzeShellCommandForPolicy(params)
      : analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
  if (!analysis.ok) {
    return {
      ok: false,
      source: params.source,
      reason: analysis.reason,
      analysis,
      segments: [],
    };
  }
  return {
    ok: true,
    source: params.source,
    analysis,
    segments: analysis.segments,
  };
}

async function analyzeShellCommandForPolicy(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecCommandAnalysis> {
  if (isWindowsPlatform(params.platform)) {
    return analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
  }
  const { createExecCommandAnalysisFromAuthorizationPlan, planCommandForAuthorization } =
    await import("../command-authorization/index.js");
  const plan = await planCommandForAuthorization(
    { dialect: "posix-shell", command: params.command },
    {
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    },
  );
  const analysis = createExecCommandAnalysisFromAuthorizationPlan({
    plan,
    cwd: params.cwd,
    env: params.env,
  });
  return analysis ?? { ok: false, reason: "unable to parse shell command", segments: [] };
}

export function detectPolicyInlineEval(segments: readonly ExecCommandSegment[]) {
  return detectInlineEvalInSegments(segments);
}

function spansOverlap(left: SourceSpan, right: SourceSpan): boolean {
  return left.startIndex < right.endIndex && right.startIndex < left.endIndex;
}

function resolveInlineEvalRiskStep(
  risk: Extract<CommandRisk, { kind: "inline-eval" }>,
  explanation: CommandExplanation,
): CommandStep | null {
  const commands = [...explanation.topLevelCommands, ...explanation.nestedCommands];
  return (
    commands.find(
      (step) => spansOverlap(step.span, risk.span) && step.executable === risk.command,
    ) ??
    commands.find((step) => spansOverlap(step.span, risk.span)) ??
    null
  );
}

function inlineEvalHitFromRisk(
  risk: Extract<CommandRisk, { kind: "inline-eval" }>,
  explanation: CommandExplanation,
): InterpreterInlineEvalHit {
  const step = resolveInlineEvalRiskStep(risk, explanation);
  return {
    executable: risk.command,
    normalizedExecutable: normalizeExecutableToken(risk.command),
    flag: risk.flag,
    argv: step?.argv ?? [risk.command, risk.flag],
  };
}

export async function detectPolicyInlineEvalForCommand(params: {
  segments: readonly ExecCommandSegment[];
  shellCommand?: string | null;
  commandText?: string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<InterpreterInlineEvalHit | null> {
  const segmentHit = detectPolicyInlineEval(params.segments);
  if (segmentHit || isWindowsPlatform(params.platform)) {
    return segmentHit;
  }

  const fallbackCommands = [params.shellCommand, params.commandText]
    .map((command) => command?.trim())
    .filter((command): command is string => Boolean(command));
  for (const command of [...new Set(fallbackCommands)]) {
    try {
      const { explainShellCommand } = await import("../command-explainer/extract.js");
      const explanation = await explainShellCommand(command);
      const risk = explanation.risks.find(
        (entry): entry is Extract<CommandRisk, { kind: "inline-eval" }> =>
          entry.kind === "inline-eval",
      );
      if (risk) {
        return inlineEvalHitFromRisk(risk, explanation);
      }
    } catch {
      continue;
    }
  }
  return null;
}
