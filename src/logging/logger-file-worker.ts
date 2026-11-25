import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { FileLogIORequest, FileLogIOResults } from "./logger-file-io.js";

export async function runFileLogIOInWorker<Request extends FileLogIORequest>(
  request: Request,
  flush: () => Promise<void>,
): Promise<FileLogIOResults[Request["type"]]> {
  const state = resolveGlobalSingleton<{
    pool?: WorkerTaskPool<FileLogIORequest, FileLogIOResults[keyof FileLogIOResults]>;
  }>(
    Symbol.for("openclaw.fileLogWorker"),
    () => ({}),
    async (owned) => {
      await flush();
      await owned.pool?.close();
      owned.pool = undefined;
    },
  );
  const pool = (state.pool ??= new WorkerTaskPool<
    FileLogIORequest,
    FileLogIOResults[keyof FileLogIOResults]
  >({
    workerUrl: resolveRuntimeProcessEntrypointUrl("fileLog"),
    workerClass: "writer",
  }));
  const result = await pool.run(request, {
    inputBytes:
      Buffer.byteLength(request.file) +
      (request.type === "append" ? Buffer.byteLength(request.payload) : 0),
  });
  // SAFETY: The registered logging worker executes the same discriminated filesystem unit.
  return result as FileLogIOResults[Request["type"]];
}
