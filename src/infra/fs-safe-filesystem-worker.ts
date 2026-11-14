import type {
  WorkspaceFilesystemCommand,
  WorkspaceFilesystemReadCommand,
  WorkspaceFilesystemReadReply,
  WorkspaceFilesystemReply,
} from "../agents/workspace-filesystem.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  FsSafeFilesystemCommand,
  FsSafeFilesystemReply,
  FsSafeStoreRemove,
  FsSafeStoreReply,
} from "./fs-safe-copy-worker-contract.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";
import type { WorkerTaskOptions } from "./worker-task-pool.types.js";

type Runtime = {
  pool?: WorkerTaskPool<FsSafeFilesystemCommand, FsSafeFilesystemReply>;
  closing?: Promise<void>;
};
type Options = Pick<WorkerTaskOptions<FsSafeFilesystemCommand>, "onNotification" | "inputBytes">;

export function runFsSafeFilesystemTask(
  command: WorkspaceFilesystemReadCommand,
  options?: Options,
): Promise<WorkspaceFilesystemReadReply>;
export function runFsSafeFilesystemTask(
  command: WorkspaceFilesystemCommand,
  options?: Options,
): Promise<WorkspaceFilesystemReply>;
export function runFsSafeFilesystemTask(
  command: FsSafeStoreRemove,
  options?: Options,
): Promise<FsSafeStoreReply>;
export function runFsSafeFilesystemTask(
  command: FsSafeFilesystemCommand,
  options: Options = {},
): Promise<FsSafeFilesystemReply> {
  const runtime = resolveGlobalSingleton<Runtime>(
    Symbol.for("openclaw.workspaceFilesystem"),
    () => ({}),
    (owned) => {
      owned.closing ??= (owned.pool?.close() ?? Promise.resolve()).finally(() => {
        owned.pool = undefined;
        owned.closing = undefined;
      });
      return owned.closing;
    },
  );
  if (runtime.closing) {
    throw new WorkerTaskError("Filesystem worker is closing; retry the operation", "unavailable");
  }
  const pool = (runtime.pool ??= new WorkerTaskPool<FsSafeFilesystemCommand, FsSafeFilesystemReply>(
    {
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy),
      maxWorkers: 2,
      idleTimeoutMs: 30_000,
    },
  ));
  return pool.run(command, options);
}
