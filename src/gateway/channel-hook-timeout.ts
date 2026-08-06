/** Result of isolating a channel plugin hook behind a host-owned deadline. */
type ChannelHookTimeoutResult<T> =
  | { kind: "value"; value: T }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

/** Bounds channel plugin work even when an adapter ignores its timeout hint. */
export async function raceChannelHookWithTimeout<T>(params: {
  timeoutMs: number;
  run: () => Promise<T> | T;
}): Promise<ChannelHookTimeoutResult<T>> {
  const timeoutMs = Math.max(1, params.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  });
  const result = await Promise.race([
    Promise.resolve()
      .then(params.run)
      .then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
    timeout,
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
}
