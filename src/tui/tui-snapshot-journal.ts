/** Replays events that arrived after an asynchronous pending-prompt snapshot began. */
export class TuiSnapshotJournal<T extends { id: string }> {
  private readonly mutations = new Map<string, { version: number; value: T | null }>();
  version = 0;

  constructor(private readonly isRefreshing: () => boolean) {}

  record(id: string, value: T | null): void {
    if (this.isRefreshing()) {
      this.mutations.set(id, { version: ++this.version, value });
    }
  }

  replay(values: Iterable<T>, startedAtVersion: number, retireApplied = false): Map<string, T> {
    const next = new Map(Array.from(values, (value) => [value.id, value]));
    for (const [id, mutation] of this.mutations) {
      if (mutation.version <= startedAtVersion) {
        if (retireApplied) {
          this.mutations.delete(id);
        }
      } else if (mutation.value) {
        next.set(id, mutation.value);
      } else {
        next.delete(id);
      }
    }
    return next;
  }

  clear(): void {
    this.mutations.clear();
  }
}
