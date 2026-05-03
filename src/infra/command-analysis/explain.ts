import { explainShellCommand } from "../command-explainer/extract.js";
import type { CommandExplanation, CommandRisk } from "../command-explainer/types.js";
import type { ExecCommandSegment } from "../exec-approvals-analysis.js";
import { detectCommandCarrierArgv, detectInlineEvalInSegments } from "./risks.js";

export type CommandExplanationSummary = {
  commandCount: number;
  nestedCommandCount: number;
  riskKinds: string[];
  warningLines: string[];
};

function riskLabel(risk: CommandRisk): string {
  switch (risk.kind) {
    case "inline-eval":
      return `${risk.command} ${risk.flag}`;
    case "shell-wrapper":
      return `${risk.executable} ${risk.flag}`;
    case "command-carrier":
      return risk.flag ? `${risk.command} ${risk.flag}` : risk.command;
    case "dynamic-argument":
      return `${risk.command} dynamic argument`;
    case "source":
      return risk.command;
    case "function-definition":
      return risk.name;
    default:
      return risk.kind;
  }
}

export function summarizeCommandExplanation(
  explanation: CommandExplanation,
): CommandExplanationSummary {
  const riskKinds = [...new Set(explanation.risks.map((risk) => risk.kind))];
  const warningLines = explanation.risks.map((risk) => {
    const label = riskLabel(risk);
    return label === risk.kind ? `Contains ${risk.kind}` : `Contains ${risk.kind}: ${label}`;
  });
  return {
    commandCount: explanation.topLevelCommands.length,
    nestedCommandCount: explanation.nestedCommands.length,
    riskKinds,
    warningLines: [...new Set(warningLines)],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function summarizeCommandSegmentsForDisplay(
  segments: readonly ExecCommandSegment[],
): CommandExplanationSummary {
  const riskKinds: string[] = [];
  const warningLines: string[] = [];
  const inlineEval = detectInlineEvalInSegments(segments);
  if (inlineEval) {
    riskKinds.push("inline-eval");
    warningLines.push(
      `Contains inline-eval: ${inlineEval.normalizedExecutable} ${inlineEval.flag}`,
    );
  }
  for (const segment of segments) {
    const effectiveArgv = segment.resolution?.effectiveArgv ?? segment.argv;
    for (const hit of detectCommandCarrierArgv(effectiveArgv)) {
      riskKinds.push("command-carrier");
      warningLines.push(
        hit.flag
          ? `Contains command-carrier: ${hit.command} ${hit.flag}`
          : `Contains command-carrier: ${hit.command}`,
      );
    }
  }
  return {
    commandCount: segments.length,
    nestedCommandCount: 0,
    riskKinds: uniqueStrings(riskKinds),
    warningLines: uniqueStrings(warningLines),
  };
}

export async function explainCommandForDisplay(
  command: string,
): Promise<{ explanation: CommandExplanation; summary: CommandExplanationSummary } | null> {
  try {
    const explanation = await explainShellCommand(command);
    return { explanation, summary: summarizeCommandExplanation(explanation) };
  } catch {
    return null;
  }
}
