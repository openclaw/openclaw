import type { ExecApprovalRequestPayload } from "./exec-approvals.js";

function normalizePreview(commandText: string, commandPreview?: string | null): string | null {
  const preview = commandPreview?.trim() ?? "";
  if (!preview || preview === commandText) {
    return null;
  }
  return preview;
}

export function resolveExecApprovalCommandDisplay(request: ExecApprovalRequestPayload): {
  commandText: string;
  commandPreview: string | null;
} {
  if (request.host === "node" && request.systemRunPlan) {
    return {
      commandText: request.systemRunPlan.commandText,
      commandPreview: normalizePreview(
        request.systemRunPlan.commandText,
        request.systemRunPlan.commandPreview,
      ),
    };
  }
  return {
    commandText: request.command,
    commandPreview: normalizePreview(request.command, request.commandPreview),
  };
}
