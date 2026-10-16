/** The inspector owns the scope; waiting never discovers or cancels other work. */
export async function waitForGatewayDrain<Snapshot extends { idle: boolean }>(
  inspect: () => Snapshot,
  timeoutMs: number | undefined,
  options: {
    pollMs: number;
    ref?: boolean;
    onSnapshot?: (snapshot: Snapshot) => void;
  },
): Promise<{ drained: boolean; elapsedMs: number; snapshot: Snapshot }> {
  const startedAt = Date.now();
  const deadlineAt =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? startedAt + Math.max(0, Math.floor(timeoutMs))
      : undefined;
  while (true) {
    const snapshot = inspect();
    options.onSnapshot?.(snapshot);
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
    if (snapshot.idle || (remainingMs !== undefined && remainingMs <= 0)) {
      return { drained: snapshot.idle, elapsedMs, snapshot };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(options.pollMs, remainingMs ?? Infinity));
      if (options.ref === false) {
        timer.unref();
      }
    });
  }
}

// Blocker descriptions can contain task identities and request origins.
export function formatGatewayDrainCounts(snapshot: { counts: Record<string, number> }): string {
  return Object.entries(snapshot.counts)
    .filter(([name, count]) => name !== "totalActive" && count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}
