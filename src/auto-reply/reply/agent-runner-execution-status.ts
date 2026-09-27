/** Projects closed execution independently of later reply delivery. */
export function resolveAgentTurnExecutionStatus(
  outcome?:
    | { kind: "aborted" | "rejected" | "observed" }
    | { kind: "settled"; status: "ok" | "failed" },
) {
  if (outcome?.kind === "settled") {
    return outcome.status;
  }
  if (outcome?.kind === "observed") {
    return "ok";
  }
  return outcome?.kind === "aborted" ? "cancelled" : "failed";
}
