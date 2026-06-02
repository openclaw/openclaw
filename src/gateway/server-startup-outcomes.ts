export type GatewayStartupOutcomeStatus = "failed" | "scheduled" | "skipped" | "started";

export type GatewayStartupOutcomeReason =
  | "disabled by environment"
  | "gateway closing"
  | "hooks not enabled"
  | "no gmail account configured"
  | "no handlers loaded"
  | "not configured"
  | "see earlier warning";

export type GatewayStartupOutcome = {
  id: string;
  status: GatewayStartupOutcomeStatus;
  reason?: GatewayStartupOutcomeReason;
};

function formatGatewayStartupOutcome(outcome: GatewayStartupOutcome): string {
  const reason = outcome.reason ? ` (${outcome.reason})` : "";
  return `${outcome.id}=${outcome.status}${reason}`;
}

export function formatGatewayStartupOutcomeSummary(
  outcomes: readonly GatewayStartupOutcome[],
): string | null {
  const formatted = outcomes.map(formatGatewayStartupOutcome);
  return formatted.length > 0 ? `gateway startup summary: ${formatted.join("; ")}` : null;
}
