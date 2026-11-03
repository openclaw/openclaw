import { createLoadingBoundary } from "@solidjs/signals";
import { createMemo, isPending } from "solid-js";
import type { PageReadResult } from "../../lib/page-request.ts";

/** Observe admitted owner work without starting another request or holding page chrome. */
export function createSystemsRead(completion: () => Promise<PageReadResult> | null) {
  // Preserve promise identity; returning it directly would make this memo asynchronous.
  const receipt = createMemo(() => ({ promise: completion() }), {
    equals: (a, b) => a.promise === b.promise,
  });
  const read = createMemo(() =>
    receipt().promise?.then((result) => {
      if (result) {
        throw result.error;
      }
    }),
  );
  const pending = createLoadingBoundary(
    () => isPending(read),
    () => true,
  );
  return { receipt, read, pending };
}
