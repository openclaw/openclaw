import type {
  WorkspaceFilesystemReadCommand,
  WorkspaceFilesystemReadReply,
} from "../agents/workspace-filesystem.types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { WorkerTaskError, WorkerTaskPool } from "./worker-task-pool.js";

type Runtime = {
  pool?: WorkerTaskPool<WorkspaceFilesystemReadCommand, WorkspaceFilesystemReadReply>;
  closing?: Promise<void>;
};
export function runFsSafeFilesystemTask(
  command: WorkspaceFilesystemReadCommand,
): Promise<WorkspaceFilesystemReadReply> {
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
  const pool = (runtime.pool ??= new WorkerTaskPool<
    WorkspaceFilesystemReadCommand,
    WorkspaceFilesystemReadReply
  >({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy),
    workerClass: "reader",
    idleTimeoutMs: 30_000,
  }));
  return pool.run(command, {
    inputBytes:
      Buffer.byteLength(command.input.filePath) + Buffer.byteLength(command.input.workspaceDir),
  });
}
