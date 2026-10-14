import type { WorkerTranscriptCommitParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-ledger.js";

const loadTranscriptCommitRuntime = createLazyRuntimeModule(
  () => import("./transcript-commit.runtime.js"),
);

export type WorkerTranscriptCommitApplication = (params: {
  identity: WorkerConnectionIdentity;
  request: WorkerTranscriptCommitParams;
  sessionTarget: BoundAgentRunSessionTarget;
  assertCurrent: () => undefined;
}) => Promise<WorkerTranscriptCommitOutcome>;

export type WorkerTranscriptCommitterOptions = {
  getConfig: () => OpenClawConfig;
  store?: WorkerTranscriptCommitStore;
};

/** Applies ordered, idempotent semantic worker turns to the canonical session transcript. */
export function createWorkerTranscriptCommitter(options: WorkerTranscriptCommitterOptions) {
  let store = options.store;
  const sessionOperations = new KeyedAsyncQueue();

  const commit: WorkerTranscriptCommitApplication = async (params) => {
    const sessionId = params.identity.sessionId;
    if (!sessionId) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (params.request.runEpoch !== params.identity.ownerEpoch) {
      return { ok: false, reason: "epoch-mismatch" };
    }
    const authority = { assertCurrent: params.assertCurrent, authorize: params.assertCurrent };
    const namespace = captureSessionActorStorageOwner(params.sessionTarget, authority);
    const captured = namespace
      ? { ...params, sessionTarget: captureSessionTranscriptTargetBinding(params.sessionTarget) }
      : params;
    const execute = () =>
      sessionOperations.enqueue(sessionId, async () => {
        // Keep loading inside the queue, before authority checks or ledger reservations.
        const { commitWorkerTranscript } = await loadTranscriptCommitRuntime();
        return await commitWorkerTranscript(
          options,
          namespace ? undefined : (store ??= createWorkerTranscriptCommitStore()),
          sessionId,
          captured,
        );
      });
    if (!namespace) {
      return execute();
    }
    return (
      (await withSessionActorStorage(
        captured.sessionTarget,
        {
          authority,
          lifetime: { assertCurrent: params.assertCurrent, assertReadable: params.assertCurrent },
        },
        execute,
      )) ?? { ok: false, reason: "session-not-attached" }
    );
  };

  return { commit };
}
