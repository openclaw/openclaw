import { resolveHomeRelativePath } from "@openclaw/fs-safe/advanced";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { SecretFileReadOptions } from "@openclaw/fs-safe/secret";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import type { SecretFileReadRequest, SecretFileReadReply } from "./secret-file-read.worker.js";
import { decodeNativeWorkerFailure } from "./worker-native-error.js";
import { WorkerTaskPool } from "./worker-task-pool.js";

export async function readSecretFileInWorker(
  filePath: string,
  label: string,
  options: SecretFileReadOptions,
): Promise<string> {
  const state = resolveGlobalSingleton<{
    pool?: WorkerTaskPool<SecretFileReadRequest, SecretFileReadReply>;
  }>(
    Symbol.for("openclaw.secretFileReads"),
    () => ({}),
    async (owned) => {
      await owned.pool?.close();
      owned.pool = undefined;
    },
  );
  const pool = (state.pool ??= new WorkerTaskPool<SecretFileReadRequest, SecretFileReadReply>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("secretFileRead"),
    workerClass: "file-reader",
  }));
  // Capture the caller's current home/cwd without doing a filesystem lookup.
  const resolvedPath = resolveHomeRelativePath(filePath.trim());
  const reply = await pool.run(
    { filePath: resolvedPath, label, options, nativeMode: getFsSafeNativeConfig().mode },
    {
      inputBytes: Buffer.byteLength(resolvedPath) + Buffer.byteLength(label),
    },
  );
  if (reply.kind === "failed") {
    const error = decodeNativeWorkerFailure(reply.error);
    throw reply.code && error instanceof Error
      ? new FsSafeError(reply.code, error.message, {
          cause: error.cause,
          details: reply.details,
        })
      : error;
  }
  return reply.value;
}
