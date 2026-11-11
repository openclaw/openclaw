import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
} from "../../process/exec-spawn.js";
import { createDeferredCore } from "../../shared/deferred.js";

export function retainedInspectionCleanup() {
  const cleanup = createDeferredCore<"forced" | "uncertain">();
  const joining = createDeferredCore();
  return {
    retain() {
      retainCommandProcessCleanup(cleanup.promise);
      resolveCommandProcessSignal()?.addEventListener("abort", () => joining.resolve(), {
        once: true,
      });
    },
    async join<T>(work: Promise<T>, result: "forced" | "uncertain", assertPending: () => void) {
      try {
        await Promise.race([
          joining.promise,
          work.then(() => {
            throw new Error("Inspection returned before retained cleanup joined");
          }),
        ]);
        assertPending();
      } finally {
        cleanup.resolve(result);
        await work;
      }
      return await work;
    },
  };
}
