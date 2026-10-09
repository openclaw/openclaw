type BoundedBufferOverflow<T> =
  | { mode: "latch" }
  | { mode: "drop-oldest"; fit?: (value: T, capacity: number) => T }
  | { mode: "fail-closed"; onOverflow: () => void };

export class BoundedBuffer<T> {
  protected values: (T | undefined)[] = [];
  private head = 0;
  private size = 0;
  private closed = false;

  constructor(
    private readonly capacity: number,
    private readonly overflow: BoundedBufferOverflow<T>,
    private readonly measure: (value: T) => number = () => 1,
  ) {}

  push(value: T): boolean {
    if (this.closed) {
      return false;
    }
    const valueSize = this.measure(value);
    if (this.size + valueSize <= this.capacity) {
      this.values.push(value);
      this.size += valueSize;
      return true;
    }
    if (this.overflow.mode !== "drop-oldest") {
      this.closed = true;
      if (this.overflow.mode === "fail-closed") {
        this.drain();
        this.overflow.onOverflow();
      }
      return false;
    }
    this.values.push(value);
    this.size += valueSize;
    // Leave the newest value for fitting; preserve the > comparison for NaN capacities.
    while (this.size > this.capacity && this.head < this.values.length - 1) {
      // SAFETY: head points to a pushed T; only slots before head have been cleared.
      const oldest = this.values[this.head] as T;
      this.size -= this.measure(oldest);
      this.values[this.head] = undefined;
      this.head += 1;
    }
    if (this.size > this.capacity) {
      const fitted = this.overflow.fit?.(value, this.capacity);
      this.values = fitted === undefined ? [] : [fitted];
      this.head = 0;
      this.size = fitted === undefined ? 0 : this.measure(fitted);
    } else if (this.head * 2 >= this.values.length) {
      // Amortize compaction across evictions instead of shifting every retained value per push.
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
    return true;
  }

  drain(): T[] {
    const values = this.head === 0 ? this.values : this.values.slice(this.head);
    this.values = [];
    this.head = 0;
    this.size = 0;
    // SAFETY: the captured suffix excludes cleared slots and preserves every pushed T, including undefined.
    return values as T[];
  }
}
