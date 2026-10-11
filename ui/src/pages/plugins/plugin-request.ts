/** One replaceable page read; state stays synchronous while Solid observes notifications. */
export class PluginRequest<Args extends readonly unknown[], Result> {
  pending = false;
  private request: AbortController | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly options: {
      task: (args: Args, options: { signal: AbortSignal }) => Promise<Result>;
      onComplete: (result: Result) => void;
      onError: (error: unknown) => void;
    },
  ) {}

  reset(): void {
    this.request?.abort();
    this.request = undefined;
    this.pending = false;
    this.notify();
  }

  async run(args: Args): Promise<void> {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.pending = true;
    this.notify();
    try {
      const result = await this.options.task(args, { signal: request.signal });
      if (this.request === request) {
        this.options.onComplete(result);
      }
    } catch (error) {
      if (this.request === request) {
        this.options.onError(error);
      }
    } finally {
      if (this.request === request) {
        this.request = undefined;
        this.pending = false;
        this.notify();
      }
    }
  }
}
