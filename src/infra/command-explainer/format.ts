import type { ExecApprovalCommandHighlight } from "../exec-approvals.js";
import type { CommandExplanation } from "./types.js";

function spanToHighlight(
  span: { startIndex: number; endIndex: number },
  kind: ExecApprovalCommandHighlight["kind"],
  severity: NonNullable<ExecApprovalCommandHighlight["severity"]>,
): ExecApprovalCommandHighlight | null {
  if (!Number.isSafeInteger(span.startIndex) || !Number.isSafeInteger(span.endIndex)) {
    return null;
  }
  if (span.startIndex < 0 || span.endIndex <= span.startIndex) {
    return null;
  }
  return { startIndex: span.startIndex, endIndex: span.endIndex, kind, severity };
}

function executableHighlightSpan(command: CommandExplanation["topLevelCommands"][number]): {
  startIndex: number;
  endIndex: number;
} {
  const relativeStart = command.text.indexOf(command.executable);
  const startIndex =
    relativeStart >= 0 ? command.span.startIndex + relativeStart : command.span.startIndex;
  return { startIndex, endIndex: startIndex + command.executable.length };
}

export function formatCommandExplanationHighlights(
  explanation: CommandExplanation,
): ExecApprovalCommandHighlight[] {
  const highlights: ExecApprovalCommandHighlight[] = [];

  for (const command of [...explanation.topLevelCommands, ...explanation.nestedCommands]) {
    const commandHighlight = spanToHighlight(executableHighlightSpan(command), "command", "info");
    if (commandHighlight) {
      highlights.push(commandHighlight);
    }
  }

  for (const risk of explanation.risks) {
    if (risk.kind === "command-carrier") {
      const riskText = risk.flag ?? risk.command;
      const relativeStart = risk.text.indexOf(riskText);
      const startIndex =
        relativeStart >= 0 ? risk.span.startIndex + relativeStart : risk.span.startIndex;
      const riskHighlight = spanToHighlight(
        { startIndex, endIndex: startIndex + riskText.length },
        "risk",
        "warning",
      );
      if (riskHighlight) {
        highlights.push(riskHighlight);
      }
      continue;
    }
    if (risk.kind === "inline-eval") {
      const riskText = `${risk.command} ${risk.flag}`;
      const relativeStart = risk.text.indexOf(riskText);
      if (relativeStart < 0) {
        continue;
      }
      const startIndex = risk.span.startIndex + relativeStart;
      const riskHighlight = spanToHighlight(
        { startIndex, endIndex: startIndex + riskText.length },
        "risk",
        "danger",
      );
      if (riskHighlight) {
        highlights.push(riskHighlight);
      }
    }
  }
  return highlights;
}

export function formatCommandExplanationLines(_explanation: CommandExplanation): string[] {
  return [];
}
