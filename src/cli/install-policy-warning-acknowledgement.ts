import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type {
  InstallPolicyWarningAcknowledgementRequest,
  InstallSafetyOverrides,
} from "../plugins/install-security-scan.types.js";
import { promptText } from "./prompt.js";

export function resolveInstallPolicyWarningAcknowledgementCliOptions(params: {
  acknowledgeInstallPolicyWarning?: boolean;
  allowPrompt?: boolean;
}): Pick<InstallSafetyOverrides, "onInstallPolicyWarning"> {
  const canPrompt =
    !params.acknowledgeInstallPolicyWarning &&
    params.allowPrompt !== false &&
    process.stdin.isTTY &&
    process.stdout.isTTY;
  return params.acknowledgeInstallPolicyWarning
    ? {
        onInstallPolicyWarning: async () => ({ status: "approved" as const }),
      }
    : canPrompt
      ? {
          onInstallPolicyWarning: async (request: InstallPolicyWarningAcknowledgementRequest) => {
            const targetName = sanitizeTerminalText(request.targetName);
            const answer = await promptText(
              `type: '${targetName}' to ${request.requestMode} anyway\n> `,
            );
            return answer.trim() === targetName ? { status: "approved" } : { status: "declined" };
          },
        }
      : {};
}
