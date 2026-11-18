import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { createSqliteReadOnlyWorkerError } from "../infra/sqlite-readonly-worker-protocol.js";
import {
  runOneShotSqliteInspection,
  runScopedSqliteInspection,
} from "../infra/sqlite-readonly-worker.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
  type OpenClawStateWorkerErrorPayload,
} from "./openclaw-state-worker-error.js";

type OpenClawStateOwnershipWorkerReply =
  | { ok: true; ownershipJson: string }
  | { ok: false; workerError: OpenClawStateWorkerErrorPayload | undefined };

function readOwnershipWorkerReply(stdout: string, stderr: string): string {
  let reply: OpenClawStateOwnershipWorkerReply;
  try {
    // This bundled child emits the private reply contract; check its envelope below.
    reply = JSON.parse(stdout);
  } catch {
    throw createSqliteReadOnlyWorkerError("returned invalid ownership JSON", stderr);
  }
  if (!isRecord(reply) || Object.keys(reply).length !== 2 || typeof reply.ok !== "boolean") {
    throw createSqliteReadOnlyWorkerError("returned an invalid ownership result", stderr);
  }
  if (reply.ok && typeof reply.ownershipJson === "string") {
    return reply.ownershipJson;
  }
  if (!reply.ok && "workerError" in reply) {
    const error = new Error("Shared-state ownership inspection failed");
    retainOpenClawStateWorkerErrorPayload(error, reply.workerError);
    throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
  }
  throw createSqliteReadOnlyWorkerError("returned an invalid ownership result", stderr);
}

/** Read live ownership in a child so closing the reader cannot release this process's locks. */
export function inspectOpenClawStateOwnershipWithWorker(
  databasePath: string,
  signal?: AbortSignal,
): Promise<string> {
  return runScopedSqliteInspection(signal, (scopedSignal) => {
    scopedSignal?.throwIfAborted();
    const { moduleUrl, runtimeGeneration } = captureRuntimeWorkerSource(
      resolveRuntimeProcessEntrypointUrl("stateOwnership"),
    );
    return runOneShotSqliteInspection({
      pathname: databasePath,
      operation: "state ownership",
      argv: [...resolveRuntimeWorkerArgv(moduleUrl), databasePath],
      runtimeGeneration,
      signal: scopedSignal,
      stoppedFailure: "ownership owner stopped",
      read: (output) => {
        scopedSignal?.throwIfAborted();
        if (output.failure) {
          throw createSqliteReadOnlyWorkerError(output.failure, output.stderr);
        }
        return readOwnershipWorkerReply(output.stdout, output.stderr);
      },
    });
  });
}

export type { OpenClawStateOwnershipWorkerReply };
