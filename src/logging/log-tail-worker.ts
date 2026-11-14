import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readLoggingConfig } from "./config.js";
import type { LogTailPayload, readConfiguredLogTail } from "./log-tail.js";
import { getResolvedLoggerFileTarget } from "./logger.js";
import { captureSecretRedactionRegistrySnapshot } from "./secret-redaction-registry.js";

export type LogTailRequest = {
  type: "tail";
  target: Awaited<ReturnType<typeof getResolvedLoggerFileTarget>>;
  params: Parameters<typeof readConfiguredLogTail>[0];
  redactPatterns: string[] | undefined;
  secrets: ReturnType<typeof captureSecretRedactionRegistrySnapshot>;
};

/** Keep file scanning and scalar redaction off the Gateway's shared event loop. */
export async function readConfiguredLogTailInWorker(
  params?: LogTailRequest["params"],
): Promise<LogTailPayload> {
  const target = await getResolvedLoggerFileTarget();
  const state = resolveGlobalSingleton<{ pool?: WorkerTaskPool<LogTailRequest, LogTailPayload> }>(
    Symbol.for("openclaw.logTailWorker"),
    () => ({}),
    async (owned) => {
      await owned.pool?.close();
      owned.pool = undefined;
    },
  );
  const pool = (state.pool ??= new WorkerTaskPool<LogTailRequest, LogTailPayload>({
    // Share the file-log entrypoint, not its writer pool: a slow tail must not queue writes.
    workerUrl: resolveRuntimeProcessEntrypointUrl("fileLog"),
    workerClass: "singleton",
    maxPendingTasks: 8,
  }));
  const request: LogTailRequest = {
    type: "tail",
    target,
    params,
    redactPatterns: readLoggingConfig()?.redactPatterns,
    secrets: captureSecretRedactionRegistrySnapshot(),
  };
  return pool.run(request, {
    inputBytes: Buffer.byteLength(JSON.stringify(request)),
  });
}
