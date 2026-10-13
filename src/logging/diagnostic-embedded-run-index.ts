// Re-arming a work key can advance its sequence without changing Map iteration order.
export function resolveCurrentDiagnosticRunId(
  owners: Iterable<{ runId: string; sequence: number }>,
): string | undefined {
  let currentOwner: { runId: string; sequence: number } | undefined;
  for (const owner of owners) {
    if (!currentOwner || owner.sequence > currentOwner.sequence) {
      currentOwner = owner;
    }
  }
  return currentOwner?.runId;
}
