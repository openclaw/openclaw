import type { ClawHubRiskAcknowledgementRequest } from "../plugins/clawhub.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import { promptText, promptYesNo } from "./prompt.js";

export type ClawHubRiskAcknowledgementCliOptions = {
  acknowledgeClawHubRisk?: boolean;
};

function canPromptForClawHubRisk(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

export function resolveClawHubRiskAcknowledgementCliOptions(params: {
  acknowledgeClawHubRisk?: boolean;
  action: "installing" | "updating";
}): ClawHubRiskAcknowledgementCliOptions & {
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => Promise<boolean>;
} {
  return {
    acknowledgeClawHubRisk: params.acknowledgeClawHubRisk,
    onClawHubRisk:
      params.acknowledgeClawHubRisk || !canPromptForClawHubRisk()
        ? undefined
        : async (request) => {
            const packageName = sanitizeTerminalText(request.packageName);
            const releaseLabel = `${packageName}@${sanitizeTerminalText(request.version)}`;
            if (request.acknowledgementKind === "type-package") {
              const answer = await promptText(
                `To ${params.action === "installing" ? "install" : "update"} anyway, type the package name for "${releaseLabel}":\n  ${packageName}\n> `,
              );
              return answer.trim() === packageName;
            }
            return await promptYesNo(
              `${params.action === "installing" ? "Install" : "Update"} ClawHub package "${releaseLabel}" after reviewing the warning above?`,
            );
          },
  };
}
