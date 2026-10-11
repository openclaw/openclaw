import { render, type JSX } from "@solidjs/web";
import { createComponent, createEffect, createSignal } from "solid-js";

const roots = new WeakMap<HTMLDivElement, () => void>();

export function disposePreview(card: HTMLDivElement): void {
  roots.get(card)?.();
  roots.delete(card);
}

/** Each portaled card keeps one Solid root until its owner closes or changes its view. */
export function createPreviewRenderer<T>(view: (props: { value: T }) => JSX.Element) {
  const updates = new WeakMap<HTMLDivElement, (value: T) => void>();
  return (card: HTMLDivElement, value: T, afterCommit: () => void): void => {
    const update = updates.get(card);
    if (update) {
      update(value);
      return;
    }
    disposePreview(card);
    const dispose = render(() => {
      const [current, setCurrent] = createSignal<T>(() => value, { ownedWrite: true });
      updates.set(card, (next) => setCurrent(() => next));
      const content = createComponent(view, {
        get value() {
          return current();
        },
      });
      createEffect(() => current(), afterCommit);
      return content;
    }, card);
    roots.set(card, () => {
      updates.delete(card);
      dispose();
    });
  };
}
