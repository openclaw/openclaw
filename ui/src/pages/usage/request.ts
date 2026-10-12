/** Requests publish into their display owner; completed payloads are never cached here. */
export function createUsageRequest<Args, Value>(
  notify: () => void,
  options: {
    task: (args: Args, options: { signal: AbortSignal }) => Promise<Value>;
    onComplete: (value: Value) => void;
    onError: (error: unknown) => void;
  },
) {
  let active: AbortController | null = null;
  const settle = (request: AbortController, publish: () => void) => {
    if (active !== request) {
      return;
    }
    // Completion may immediately start a successor through the refresh policy.
    active = null;
    try {
      publish();
    } catch {
      // Completion notifications retain the former Task's error isolation.
    } finally {
      notify();
    }
  };
  return {
    get pending() {
      return active !== null;
    },
    cancel: () => {
      const previous = active;
      active = null;
      previous?.abort();
      notify();
    },
    async run(args: Args): Promise<void> {
      const previous = active;
      const request = new AbortController();
      active = request;
      previous?.abort();
      notify();
      let value: Value;
      try {
        value = await options.task(args, { signal: request.signal });
      } catch (error) {
        settle(request, () => options.onError(error));
        return;
      }
      settle(request, () => options.onComplete(value));
    },
  };
}
