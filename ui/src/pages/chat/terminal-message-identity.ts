const liveTerminalRunIds = new WeakMap<object, string>();

/** Associates a live terminal projection with its run without altering transcript bytes. */
export function rememberLiveTerminalRun(
  message: unknown,
  runId: string | null | undefined,
): unknown {
  if (runId && message && typeof message === "object") {
    liveTerminalRunIds.set(message, runId);
  }
  return message;
}

export function isLiveTerminalForRun(message: unknown, runId: string): boolean {
  return Boolean(
    message && typeof message === "object" && liveTerminalRunIds.get(message) === runId,
  );
}
