// Command-analysis display helpers turn parsed command policy data into small
// warning summaries for approval surfaces without loading the rich parser path.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { CommandRisk } from "../command-explainer/types.js";
import type { ExecCommandSegment } from "../exec-approvals-analysis.js";
import { analyzeArgvCommand } from "../exec-argv-analysis.js";
import { detectCommandCarrierArgv, detectInlineEvalInSegments } from "./risks.js";

export type CommandExplanationSummary = {
  commandCount: number;
  nestedCommandCount: number;
  riskKinds: string[];
  warningLines: string[];
};

// Risk labels keep warnings readable without exposing full command payloads.
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

function summarizeCommandSegmentsForDisplay(
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

export async function resolveCommandAnalysisSummaryForDisplay(params: {
  host?: string | null;
  commandText: string;
  commandArgv?: string[];
  cwd?: string | null;
  sanitizeText?: (value: string) => string;
}): Promise<CommandExplanationSummary | null> {
  let summary: CommandExplanationSummary;
  if (params.host === "node") {
    if (!Array.isArray(params.commandArgv) || params.commandArgv.length === 0) {
      return null;
    }
    const analysis = analyzeArgvCommand({
      argv: params.commandArgv,
      cwd: params.cwd ?? undefined,
    });
    if (!analysis.ok) {
      return null;
    }
    summary = summarizeCommandSegmentsForDisplay(analysis.segments);
  } else {
    try {
      const { explainShellCommand } = await import("../command-explainer/extract.js");
      const explanation = await explainShellCommand(params.commandText);
      summary = {
        commandCount: explanation.topLevelCommands.length,
        nestedCommandCount: explanation.nestedCommands.length,
        riskKinds: uniqueStrings(explanation.risks.map((risk) => risk.kind)),
        warningLines: uniqueStrings(
          explanation.risks.map((risk) => {
            const label = riskLabel(risk);
            return label === risk.kind
              ? `Contains ${risk.kind}`
              : `Contains ${risk.kind}: ${label}`;
          }),
        ),
      };
    } catch {
      return null;
    }
  }
  const sanitizeText = params.sanitizeText;
  if (!sanitizeText) {
    return summary;
  }
  return {
    commandCount: summary.commandCount,
    nestedCommandCount: summary.nestedCommandCount,
    riskKinds: summary.riskKinds.map((kind) => sanitizeText(kind)),
    warningLines: summary.warningLines.map((line) => sanitizeText(line)),
  };
}
