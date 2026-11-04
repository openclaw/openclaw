/** Named clocks retain the pet controller's existing replacement and cancellation policy. */
export class LobsterPetTimers<Name extends string> {
  private readonly pending = new Map<Name, number>();

  constructor(private readonly onFire: () => void = () => {}) {}

  has(name: Name): boolean {
    return this.pending.has(name);
  }

  schedule(name: Name, delayMs: number, callback: () => void): void {
    // Callers explicitly cancel replacements; firing releases the slot before scheduling more work.
    this.pending.set(
      name,
      window.setTimeout(() => {
        this.pending.delete(name);
        callback();
        this.onFire();
      }, delayMs),
    );
  }

  clear(...names: Name[]): void {
    for (const name of names) {
      const timer = this.pending.get(name);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        this.pending.delete(name);
      }
    }
  }
}
