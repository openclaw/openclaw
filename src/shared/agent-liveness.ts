export function isBlockedLivenessState(livenessState: unknown): boolean {
  return typeof livenessState === "string" && livenessState.trim().toLowerCase() === "blocked";
}

export function formatBlockedLivenessError(error: unknown): string {
  const message = typeof error === "string" ? error.trim() : "";
  return message || "Agent run blocked before producing a usable result.";
}
