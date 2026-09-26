import fsSync from "node:fs";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "../infra/sqlite-readonly-worker.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  STATE_RECOVERY_PREPARATION_CHILD_ARG,
  stateRecoveryPreparationRequestSchema,
  stateRecoveryPreparationResponseSchema,
  type StateRecoveryPreparationRequest,
} from "./openclaw-state-recovery-preparation-protocol.js";

type RecoveryWorkerAuthority = {
  assertOwned: () => void;
  signal?: AbortSignal;
};

async function runRecoveryPreparationWorker(
  input: StateRecoveryPreparationRequest,
  params: RecoveryWorkerAuthority,
) {
  const request = stateRecoveryPreparationRequestSchema.parse(input);
  params.assertOwned();
  params.signal?.throwIfAborted();
  const sourcePaths =
    request.operation === "sanitize-state"
      ? [request.targetPath]
      : [request.baselinePath, request.candidatePath];
  const sizes = await Promise.all(
    sourcePaths.map(async (pathname) => ({
      path: pathname,
      sizeBytes: (await fs.stat(pathname, { bigint: true })).size,
    })),
  );
  params.assertOwned();
  params.signal?.throwIfAborted();
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateRecoveryPreparation);
  const result = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(workerUrl),
      STATE_RECOVERY_PREPARATION_CHILD_ARG,
    ],
    {
      input: JSON.stringify(request),
      cwd: process.cwd(),
      baseEnv: process.env,
      ...(/\.[cm]?ts$/u.test(fileURLToPath(workerUrl))
        ? { env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", workerUrl)) } }
        : {}),
      signal: params.signal,
      timeoutMs: resolveAggregateSqliteInspectionTimeoutMs("recovery preparation", sizes),
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      maxOutputBytes: { stdout: 64 * 1024, stderr: 64 * 1024 },
      terminateOnOutputLimit: true,
    },
  );
  if (result.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (
    result.code !== 0 ||
    result.termination !== "exit" ||
    result.signal ||
    result.killed ||
    result.outputLimitExceeded
  ) {
    throw new Error(`Recovery preparation worker failed: ${result.stderr.slice(-2048)}`);
  }
  const response = stateRecoveryPreparationResponseSchema.parse(JSON.parse(result.stdout));
  try {
    params.assertOwned();
    params.signal?.throwIfAborted();
  } catch (error) {
    if (request.operation === "prepare-state" && response.ok && response.identity) {
      const current = fsSync.lstatSync(request.targetPath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      const expected = response.identity;
      if (
        current?.isFile() &&
        current.dev !== 0n &&
        current.ino !== 0n &&
        String(current.dev) === expected.dev &&
        String(current.ino) === expected.ino &&
        String(current.size) === expected.size &&
        String(current.mtimeNs) === expected.mtimeNs &&
        String(current.birthtimeNs) === expected.birthtimeNs
      ) {
        fsSync.unlinkSync(request.targetPath);
      }
    }
    throw error;
  }
  if (!response.ok) {
    throw Object.assign(new Error(response.error), response.code ? { code: response.code } : {});
  }
  return response;
}

export async function prepareOpenClawStateRecoveryCopy(params: {
  baselinePath: string;
  candidatePath: string;
  targetPath: string;
  assertOwned: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await runRecoveryPreparationWorker(
    {
      operation: "prepare-state",
      baselinePath: params.baselinePath,
      candidatePath: params.candidatePath,
      targetPath: params.targetPath,
    },
    params,
  );
  if (!response.identity) {
    throw new Error("Recovery preparation worker omitted its target identity.");
  }
}

export async function sanitizePreparedOpenClawStateCopy(
  targetPath: string,
  authority: RecoveryWorkerAuthority,
): Promise<void> {
  await runRecoveryPreparationWorker({ operation: "sanitize-state", targetPath }, authority);
}

export async function assertPreparedAgentRecoveryRepresentation(
  params: {
    baselinePath: string;
    candidatePath: string;
    agentId: string;
    supportedVersion: number;
  } & RecoveryWorkerAuthority,
): Promise<void> {
  await runRecoveryPreparationWorker(
    {
      operation: "compare-agent",
      baselinePath: params.baselinePath,
      candidatePath: params.candidatePath,
      agentId: params.agentId,
      supportedVersion: params.supportedVersion,
    },
    params,
  );
}
