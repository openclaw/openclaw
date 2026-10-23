import { render, spread, type JSX } from "@solidjs/web";
import { createMemo, createSignal, onSettled } from "solid-js";
import { createResizeObserver } from "../lib/reactive/observers.ts";
import { controlsForHovercard, HovercardControlsContext } from "./portaled-hovercard-focus.ts";

const roots = new WeakMap<HTMLDivElement, () => void>();

export function disposePreview(card: HTMLDivElement): void {
  roots.get(card)?.();
  roots.delete(card);
}

/** Each portaled card keeps one Solid root until its owner closes or changes its view. */
export function createPreviewRenderer<T>(
  View: (props: { value: T }) => JSX.Element,
  label: (value: T) => string,
) {
  const updates = new WeakMap<HTMLDivElement, (value: T) => void>();
  return (card: HTMLDivElement, value: T, afterCommit: () => void): void => {
    const update = updates.get(card);
    if (update) {
      update(value);
      return;
    }
    disposePreview(card);
    let active = true;
    const afterUpdate = () =>
      onSettled(() => {
        if (active) {
          afterCommit();
        }
      });
    const dispose = render(() => {
      const [current, setCurrent] = createSignal<T>(() => value, { ownedWrite: true });
      const attributes = createMemo(() => ({ "aria-label": label(current()) }));
      spread(card, attributes, true);
      createResizeObserver(() => [card], afterCommit);
      updates.set(card, (next) => {
        setCurrent(() => next);
        afterUpdate();
      });
      const content = (
        <HovercardControlsContext value={controlsForHovercard(card)}>
          <View value={current()} />
        </HovercardControlsContext>
      );
      afterUpdate();
      return content;
    }, card);
    roots.set(card, () => {
      active = false;
      updates.delete(card);
      dispose();
    });
  };
}
