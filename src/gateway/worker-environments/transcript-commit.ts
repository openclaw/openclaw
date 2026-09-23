import type { WorkerTranscriptCommitParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-store.js";

const loadTranscriptCommitRuntime = createLazyRuntimeModule(
  () => import("./transcript-commit.runtime.js"),
);

export type WorkerTranscriptCommitApplication = (params: {
  identity: WorkerConnectionIdentity;
  request: WorkerTranscriptCommitParams;
  assertCurrent: () => undefined;
}) => Promise<WorkerTranscriptCommitOutcome>;

export type WorkerTranscriptCommitterOptions = {
  getConfig: () => OpenClawConfig;
  store?: WorkerTranscriptCommitStore;
};

/** Applies ordered, idempotent semantic worker turns to the canonical session transcript. */
export function createWorkerTranscriptCommitter(options: WorkerTranscriptCommitterOptions) {
  const store = options.store ?? createWorkerTranscriptCommitStore();
  const sessionOperations = new KeyedAsyncQueue();

  const commit: WorkerTranscriptCommitApplication = async (params) => {
    const sessionId = params.identity.sessionId;
    if (!sessionId) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (params.request.runEpoch !== params.identity.ownerEpoch) {
      return { ok: false, reason: "epoch-mismatch" };
    }
    return await sessionOperations.enqueue(sessionId, async () => {
      // Keep loading inside the queue, before authority checks or ledger reservations.
      const { commitWorkerTranscript } = await loadTranscriptCommitRuntime();
      return await commitWorkerTranscript(options, store, sessionId, params);
    });
  };

  return { commit };
}
