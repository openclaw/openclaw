/** Build the canonical transcript idempotency key for an agent run's input turn. */
export function buildRunUserTurnIdempotencyKey(runId: string): string {
  return `${runId}:user`;
}
