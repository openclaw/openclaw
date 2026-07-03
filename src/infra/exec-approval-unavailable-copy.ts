// Resolves user-facing copy for optional exec approval decisions that cannot be used.
import {
  normalizeExecAsk,
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalDecision,
  type ExecApprovalUnavailableDecision,
} from "./exec-approvals.js";

export type ExecApprovalAllowAlwaysUnavailableReason =
  | "policy-ask-always"
  | "one-shot-command"
  | "unavailable";

export function normalizeExecApprovalAllowAlwaysUnavailableReason(
  value?: string | null,
): ExecApprovalAllowAlwaysUnavailableReason | null {
  return value === "policy-ask-always" || value === "one-shot-command" || value === "unavailable"
    ? value
    : null;
}

function hasAllowAlwaysUnavailable(decisions?: readonly string[] | null): boolean {
  return Array.isArray(decisions) && decisions.includes("allow-always");
}

export function resolveExecApprovalAllowAlwaysUnavailableReason(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  allowAlwaysUnavailableReason?: string | null;
}): ExecApprovalAllowAlwaysUnavailableReason | null {
  const allowedDecisions =
    params?.allowedDecisions ??
    resolveExecApprovalRequestAllowedDecisions({
      ask: params?.ask,
      unavailableDecisions: params?.unavailableDecisions,
    });
  if (allowedDecisions.includes("allow-always")) {
    return null;
  }

  if (normalizeExecAsk(params?.ask) === "always") {
    return "policy-ask-always";
  }

  const explicit = normalizeExecApprovalAllowAlwaysUnavailableReason(
    params?.allowAlwaysUnavailableReason,
  );
  if (explicit) {
    return explicit;
  }
  if (hasAllowAlwaysUnavailable(params?.unavailableDecisions)) {
    return "one-shot-command";
  }
  return "unavailable";
}

export function describeExecApprovalAllowAlwaysUnavailable(
  reason: ExecApprovalAllowAlwaysUnavailableReason,
): string {
  switch (reason) {
    case "policy-ask-always":
      return "The effective approval policy requires approval every time, so Allow Always is unavailable.";
    case "one-shot-command":
      return "Allow Always is unavailable because this command is one-shot and cannot be saved as a reusable approval.";
    case "unavailable":
      return "Allow Always is unavailable for this request.";
  }
}

export function resolveExecApprovalAllowAlwaysUnavailableText(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  allowAlwaysUnavailableReason?: string | null;
}): string | null {
  const reason = resolveExecApprovalAllowAlwaysUnavailableReason(params);
  return reason ? describeExecApprovalAllowAlwaysUnavailable(reason) : null;
}
