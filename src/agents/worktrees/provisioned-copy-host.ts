import type {
  FsSafeCopyReply,
  FsSafeProvisionCopy,
} from "../../infra/fs-safe-copy-worker-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createWorkerMutationAuthority } from "../../infra/worker-mutation-authority.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  recordWorktreePreparationFailure,
  setWorktreePreparationCopyDetails,
  startWorktreePreparationPhase,
} from "./preparation-timing.js";

type Runtime = {
  pool?: WorkerTaskPool<FsSafeProvisionCopy, FsSafeCopyReply>;
  closing?: Promise<void>;
};

export async function copyProvisionedPathsInWorker(
  source: string,
  destination: string,
  paths: readonly string[],
  options: { signal?: AbortSignal; assertCurrent?: () => void },
): Promise<string[]> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    options.signal?.throwIfAborted();
  };
  assertCurrent();
  const runtime = resolveGlobalSingleton<Runtime>(
    Symbol.for("openclaw.worktreeProvisionCopies"),
    () => ({}),
    (owned) => {
      owned.closing ??= (owned.pool?.close() ?? Promise.resolve()).then(() => {
        owned.pool = undefined;
        owned.closing = undefined;
      });
      return owned.closing;
    },
  );
  if (runtime.closing) {
    throw new WorkerTaskError(
      "Worktree provisioning is closing; retry the operation",
      "unavailable",
    );
  }
  const pool = (runtime.pool ??= new WorkerTaskPool<FsSafeProvisionCopy, FsSafeCopyReply>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy),
    // Copy custody must not occupy the shared Git/compute admission queue.
    maxWorkers: 2,
    idleTimeoutMs: 30_000,
  }));
  const authority = createWorkerMutationAuthority(assertCurrent, options.signal);
  // Until the first mutation request, time includes pool admission, worker startup,
  // and filesystem preflight. Do not report it as time spent copying file bytes.
  const finishWait = startWorktreePreparationPhase("provisionCopyWait");
  let finishCopy: (() => void) | undefined;
  try {
    const reply = await pool.run(
      { type: "provision", source, destination, paths, decision: authority.buffer },
      {
        signal: options.signal,
        inputBytes: paths.reduce((bytes, pathname) => bytes + Buffer.byteLength(pathname), 0),
        onNotification: () => {
          if (authority.onNotification() && !finishCopy) {
            finishWait();
            finishCopy = startWorktreePreparationPhase("provisionCopy");
          }
        },
      },
    );
    if ("copyDetails" in reply && reply.copyDetails) {
      setWorktreePreparationCopyDetails(reply.copyDetails);
    }
    authority.throwIfRefused();
    assertCurrent();
    if (reply.type === "failed") {
      throw Object.assign(new Error(reply.message), { code: reply.code });
    }
    if (reply.type !== "provisioned") {
      throw new Error("Worktree provisioning returned no completion receipt");
    }
    return reply.paths;
  } catch (error) {
    let cause = error;
    try {
      authority.throwIfRefused();
    } catch (refused) {
      cause = refused;
    }
    recordWorktreePreparationFailure(finishCopy ? "provisionCopy" : "provisionCopyWait", cause);
    throw cause;
  } finally {
    finishWait();
    finishCopy?.();
    authority.dispose();
  }
}
