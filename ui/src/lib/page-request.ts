export type PageReadResult = { error: unknown } | null;

/** Requests publish into their display owner; completed payloads are never cached here. */
export function createPageRequest<Args, Value>(
  notify: () => void,
  options: {
    task: (args: Args, options: { signal: AbortSignal }) => Promise<Value>;
    onComplete: (value: Value) => void;
    onError: (error: unknown) => void;
  },
) {
  let active: {
    controller: AbortController;
    completion: PromiseWithResolvers<PageReadResult>;
  } | null = null;
  let read: Promise<PageReadResult> | null = null;
  const cancel = () => {
    const previous = active;
    active = null;
    read = null;
    previous?.controller.abort();
    // Retired UI reads must not hold a replacement scope until transport settles.
    previous?.completion.resolve(null);
  };
  return {
    get pending() {
      return active !== null;
    },
    get read() {
      return read;
    },
    cancel,
    reset: () => {
      cancel();
      notify();
    },
    async run(args: Args): Promise<void> {
      cancel();
      const request = {
        controller: new AbortController(),
        completion: Promise.withResolvers<PageReadResult>(),
      };
      active = request;
      read = request.completion.promise;
      notify();
      let publish: () => void;
      let result: PageReadResult = null;
      try {
        const value = await options.task(args, { signal: request.controller.signal });
        publish = () => options.onComplete(value);
      } catch (error) {
        result = { error };
        publish = () => options.onError(error);
      }
      if (active !== request) {
        return;
      }
      // Completion may immediately start a successor through the refresh policy.
      active = null;
      try {
        publish();
      } catch (error) {
        result = { error };
        throw error;
      } finally {
        request.completion.resolve(result);
        notify();
      }
    },
  };
}
