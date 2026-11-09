/** Serializes pointer and key events; handoff drops work still waiting in the queue. */
export class SimulatorInputQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly canDispatch: () => boolean,
    private readonly onError: (cause: unknown) => void,
  ) {}

  enqueue(operation: () => Promise<unknown>): Promise<void> {
    const generation = this.generation;
    this.tail = this.tail
      .then(async () => {
        if (generation === this.generation && this.canDispatch()) {
          await operation();
        }
      })
      .catch((cause: unknown) => {
        if (generation === this.generation) {
          this.onError(cause);
        }
      });
    return this.tail;
  }

  retire(): void {
    this.generation += 1;
    this.tail = Promise.resolve();
  }
}
