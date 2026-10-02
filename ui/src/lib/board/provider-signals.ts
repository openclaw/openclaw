import { registerListener } from "../../../../src/shared/listeners.js";

export type BoardSnapshotSignal<T> = {
  readonly value: T;
  subscribe(listener: () => void): () => void;
};

export type BoardEventStream<T> = {
  subscribe(listener: (event: T) => void): () => void;
};

export class ValueSignal<T> implements BoardSnapshotSignal<T> {
  private readonly listeners = new Set<() => void>();

  constructor(public value: T) {}

  subscribe(listener: () => void): () => void {
    return registerListener(this.listeners, listener);
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export class EventStream<T> implements BoardEventStream<T> {
  private readonly listeners = new Set<(event: T) => void>();

  subscribe(listener: (event: T) => void): () => void {
    return registerListener(this.listeners, listener);
  }

  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
