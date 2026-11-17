import { hasCommandProcessCleanupError } from "../process/exec-result.js";

/** Closing revokes publication; only completed physical cleanup makes disposal final. */
export function createPluginNativeCaptureState(owner: {
  directory: string;
  commit(): void;
  dispose(committed: boolean): void;
  disposeAsync(committed: boolean): Promise<void>;
}) {
  let committed = false;
  let state: "open" | "closing" | "disposed" = "open";
  let pending: Promise<void> | undefined;
  return {
    directory: owner.directory,
    commit() {
      if (state !== "open") {
        throw new Error("Plugin native capture has been disposed");
      }
      owner.commit();
      committed = true;
    },
    dispose() {
      if (state === "disposed" || pending) {
        return;
      }
      state = "closing";
      owner.dispose(committed);
      state = "disposed";
    },
    async disposeAsync() {
      if (state === "disposed") {
        return;
      }
      if (pending) {
        return pending;
      }
      state = "closing";
      let releasePending = true;
      pending = owner
        .disposeAsync(committed)
        .then(() => {
          state = "disposed";
        })
        .catch((error: unknown) => {
          releasePending = !hasCommandProcessCleanupError(error);
          throw error;
        })
        .finally(() => {
          // An uncertain child retains the original rejected operation, never a retry.
          if (releasePending) {
            pending = undefined;
          }
        });
      return pending;
    },
  };
}
