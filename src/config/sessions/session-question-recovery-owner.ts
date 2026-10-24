import { isMainThread } from "node:worker_threads";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Alias relocation has no accepted owner for transferring durable native recovery fences. */
export function assertQuestionAliasRelocation(previous: SessionEntry | undefined): void {
  assertQuestionLifecycleWorker(previous);
  if (previous?.durableQuestionOwners?.length) {
    throw new Error("Alias relocation cannot transfer durable question recovery ownership.");
  }
}

/** Synchronous legacy and Doctor writes cannot retire worker-owned question custody. */
export function assertQuestionLifecycleWorker(previous: SessionEntry | undefined): void {
  if (isMainThread && previous?.durableQuestionOwners?.length) {
    throw new Error(
      "Durable question lifecycle changes require the owning session worker; use the asynchronous lifecycle writer.",
    );
  }
}
