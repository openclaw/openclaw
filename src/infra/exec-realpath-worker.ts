import type { FsSafeNativeMode } from "@openclaw/fs-safe/config";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

export type ExecRealpathInput = { path: string; mode: FsSafeNativeMode };
type ExecRealpathPool = WorkerTaskPool<ExecRealpathInput, string | undefined>;

/** Bun's native canonicalizer is synchronous; only this worker performs that lookup. */
export async function resolveExecRealpathInWorker(
  filePath: string,
  mode: FsSafeNativeMode,
): Promise<string> {
  const source = captureRuntimeWorkerSource(resolveRuntimeProcessEntrypointUrl("execRealpath"));
  const pools = resolveGlobalMap<string, ExecRealpathPool>(
    Symbol.for("openclaw.execRealpathPools"),
    async (retained) => {
      await Promise.all([...retained.values()].map((pool) => pool.close()));
      retained.clear();
    },
  );
  const key = source.moduleUrl.href;
  let pool = pools.get(key);
  if (!pool || pool.isClosed) {
    pool = new WorkerTaskPool({ workerUrl: source.moduleUrl, workerClass: "singleton" });
    pools.set(key, pool);
    const retained = pool;
    source.runtimeGeneration?.retain(pool, async () => {
      await retained.close();
      pools.delete(key);
    });
  }
  const resolved = await pool.run({ path: filePath, mode }, {});
  if (resolved === undefined) {
    throw new Error("Exec path could not be resolved under the filesystem policy");
  }
  return resolved;
}
