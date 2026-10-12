// Re-arming a work key can advance its sequence without changing Map iteration order.
export function resolveCurrentDiagnosticRun<TOwner extends { runId: string; sequence: number }>(
  owners: Iterable<TOwner>,
): TOwner | undefined {
  let currentOwner: TOwner | undefined;
  for (const owner of owners) {
    if (!currentOwner || owner.sequence > currentOwner.sequence) {
      currentOwner = owner;
    }
  }
  return currentOwner;
}

export function resolveCurrentDiagnosticRunId(
  owners: Iterable<{ runId: string; sequence: number }>,
): string | undefined {
  return resolveCurrentDiagnosticRun(owners)?.runId;
}
