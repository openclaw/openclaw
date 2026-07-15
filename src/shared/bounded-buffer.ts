type BoundedBufferOverflow<T> =
  | { mode: "latch" }
  | { mode: "drop-oldest"; fit?: (value: T, capacity: number) => T }
  | { mode: "fail-closed"; onOverflow: () => void };

export class BoundedBuffer<T> {
  protected values: T[] = [];
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
    if (this.overflow.mode === "latch") {
      this.closed = true;
      return false;
    }
    if (this.overflow.mode === "fail-closed") {
      this.values = [];
      this.size = 0;
      this.closed = true;
      this.overflow.onOverflow();
      return false;
    }
    this.values.push(value);
    this.size += valueSize;
        // Only drop old elements if the new element itself fits within capacity.
    // Otherwise the fit/clear path below will handle it, and dropping old
    // elements would be wasted work (especially when measure() returns 0
    // for already-stored elements, causing the loop to scan them all).
 (valueSize <= this.capacity) {
      while (this.size > this.capacity && this.values.length > 1) {
        this.size -= this.measure(this.values.shift()!);
      }
    }
    if (this.size > this.capacity) {
      const fitted = this.overflow.fit?.(value, this.capacity);
      this.values = fitted === undefined ? [] : [fitted];
      this.size = fitted === undefined ? 0 : this.measure(fitted);
    }
    return true;
  }

  drain(): T[] {
    const values = this.values;
    this.values = [];
    this.size = 0;
    return values;
  }
}
