import { vi } from "vitest";
import * as cleanupReads from "./cleanup-service-read.js";
import type { SessionCleanupReadResult } from "./cleanup-service-read.types.js";

export function afterCleanupRead(
  callback: (snapshot: SessionCleanupReadResult, fixMissing?: boolean) => void,
) {
  const readStore = cleanupReads.withSessionCleanupStore;
  return vi
    .spyOn(cleanupReads, "withSessionCleanupStore")
    .mockImplementation((target, consume, options) =>
      readStore(
        target,
        (owner) =>
          consume({
            ...owner,
            read: async (fixMissing) => {
              const snapshot = await owner.read(fixMissing);
              callback(snapshot, fixMissing);
              return snapshot;
            },
          }),
        options,
      ),
    );
}
