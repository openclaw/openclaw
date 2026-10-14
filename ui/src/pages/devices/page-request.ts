/** Cancellable reads publish only while they still own this page request slot. */
export function createPageRequest<Args extends readonly unknown[], Result>(options: {
  args: () => Args;
  task: (args: Args, context: { signal: AbortSignal }) => Promise<Result> | undefined;
  onComplete: (result: Result) => void;
  onError: (error: unknown) => void;
}) {
  let current: AbortController | null = null;
  const cancel = () => {
    current?.abort();
    current = null;
  };
  return {
    get pending() {
      return current !== null;
    },
    cancel,
    async run(args = options.args()): Promise<void> {
      cancel();
      const controller = new AbortController();
      current = controller;
      try {
        const result = await options.task(args, { signal: controller.signal });
        if (current === controller && result !== undefined) {
          options.onComplete(result);
        }
      } catch (error) {
        if (current === controller) {
          options.onError(error);
        }
      } finally {
        if (current === controller) {
          current = null;
        }
      }
    },
  };
}
