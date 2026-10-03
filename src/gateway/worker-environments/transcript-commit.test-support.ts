import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

export function createInterruptedCommitter(
  getConfig: () => OpenClawConfig,
  store: WorkerTranscriptCommitStore,
  message: string,
) {
  let interruptCompletion = true;
  return createWorkerTranscriptCommitter({
    getConfig,
    store: {
      ...store,
      complete: (input, assertCurrent) => {
        if (interruptCompletion) {
          interruptCompletion = false;
          throw new Error(message);
        }
        return store.complete(input, assertCurrent);
      },
    },
  });
}
