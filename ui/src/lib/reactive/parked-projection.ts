import { createMemo, untrack, type Accessor } from "@solidjs/signals";

/** Retain the mounted value, dropping source dependencies until presentation resumes. */
export function createParkedProjection<T>(read: () => T, presented: () => boolean): Accessor<T> {
  const snapshot = createMemo<{ value: T }>((previous) => {
    if (!presented()) {
      // A hidden first mount still needs content, but must not acquire live sources.
      return previous ?? { value: untrack(read) };
    }
    return { value: read() };
  });
  return () => snapshot().value;
}
