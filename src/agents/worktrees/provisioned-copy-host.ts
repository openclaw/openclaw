import type {
  FsSafeCopyReply,
  FsSafeProvisionCopy,
} from "../../infra/fs-safe-copy-worker-contract.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

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
  const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let failure: { error: unknown } | undefined;
  const refuse = () => {
    failure ??= { error: options.signal?.reason };
    Atomics.store(decision, 0, 2);
    Atomics.notify(decision, 0);
  };
  options.signal?.addEventListener("abort", refuse, { once: true });
  try {
    const reply = await pool.run(
      { type: "provision", source, destination, paths, decision: decision.buffer },
      {
        signal: options.signal,
        inputBytes: paths.reduce((bytes, pathname) => bytes + Buffer.byteLength(pathname), 0),
        onNotification: () => {
          try {
            if (failure) {
              throw failure.error;
            }
            assertCurrent();
            Atomics.compareExchange(decision, 0, 0, 1);
          } catch (error) {
            failure ??= { error };
            Atomics.store(decision, 0, 2);
          }
          Atomics.notify(decision, 0);
        },
      },
    );
    if (failure) {
      throw failure.error;
    }
    assertCurrent();
    if (reply.type === "failed") {
      throw Object.assign(new Error(reply.message), { code: reply.code });
    }
    if (reply.type !== "provisioned") {
      throw new Error("Worktree provisioning returned no completion receipt");
    }
    return reply.paths;
  } catch (error) {
    throw failure ? failure.error : error;
  } finally {
    options.signal?.removeEventListener("abort", refuse);
  }
}
