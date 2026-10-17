import { onCleanup } from "solid-js";

/** One replaceable page read; request authority remains synchronous. */
export function createPluginRequest<Args extends readonly unknown[], Result>(
  notify: () => void,
  options: {
    task: (args: Args, options: { signal: AbortSignal }) => Promise<Result>;
    onComplete: (result: Result) => void;
    onError: (error: unknown) => void;
  },
) {
  let current: AbortController | undefined;
  function cancel() {
    current?.abort();
    current = undefined;
  }
  onCleanup(cancel);
  return {
    get pending() {
      return current !== undefined;
    },
    reset() {
      cancel();
      notify();
    },
    async run(args: Args): Promise<void> {
      current?.abort();
      const request = new AbortController();
      current = request;
      notify();
      try {
        const result = await options.task(args, { signal: request.signal });
        if (current === request) {
          options.onComplete(result);
        }
      } catch (error) {
        if (current === request) {
          options.onError(error);
        }
      } finally {
        if (current === request) {
          current = undefined;
          notify();
        }
      }
    },
  };
}
