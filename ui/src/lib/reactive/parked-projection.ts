import { createMemo, untrack, type Accessor } from "@solidjs/signals";

/** Park live dependencies; a preparation change may refresh the retained value once. */
export function createParkedProjection<T>(
  read: () => T,
  presented: () => boolean,
  prepare?: () => unknown,
): Accessor<T> {
  const snapshot = createMemo<{ value: T; preparation: unknown }>((previous) => {
    const preparation = prepare?.();
    if (!presented()) {
      // A hidden first mount still needs content, but must not acquire live sources.
      if (previous && Object.is(previous.preparation, preparation)) {
        return previous;
      }
      const initialHiddenValue = untrack(read);
      return { value: initialHiddenValue, preparation };
    }
    return { value: read(), preparation };
  });
  return () => snapshot().value;
}
