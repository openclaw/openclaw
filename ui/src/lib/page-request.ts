/** Requests publish into their display owner; completed payloads are never cached here. */
export function createPageRequest<Args, Value>(
  notify: () => void,
  options: {
    task: (args: Args, options: { signal: AbortSignal }) => Promise<Value>;
    onComplete: (value: Value) => void;
    onError: (error: unknown) => void;
  },
) {
  let active: AbortController | null = null;
  const cancel = () => {
    const previous = active;
    active = null;
    previous?.abort();
  };
  return {
    get pending() {
      return active !== null;
    },
    cancel,
    reset: () => {
      cancel();
      notify();
    },
    async run(args: Args): Promise<void> {
      cancel();
      const request = new AbortController();
      active = request;
      notify();
      let publish: () => void;
      try {
        const value = await options.task(args, { signal: request.signal });
        publish = () => options.onComplete(value);
      } catch (error) {
        publish = () => options.onError(error);
      }
      if (active !== request) {
        return;
      }
      // Completion may immediately start a successor through the refresh policy.
      active = null;
      try {
        publish();
      } finally {
        notify();
      }
    },
  };
}
