import { createEffect } from "solid-js";

/** Consume each focus request once, after its target is ready. */
export function createPendingFocus<T>(
  read: () => T,
  policy: {
    // undefined preserves the pending request; false cancels it.
    requested: (next: T, previous: T | undefined) => boolean | undefined;
    ready?: (next: T) => boolean;
    focus: (next: T) => void;
  },
) {
  let pending = false;
  createEffect(read, (next, previous) => {
    pending = policy.requested(next, previous) ?? pending;
    if (!pending || policy.ready?.(next) === false) {
      return;
    }
    pending = false;
    policy.focus(next);
  });
}
