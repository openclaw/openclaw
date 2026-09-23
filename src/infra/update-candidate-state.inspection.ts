import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import { createUpdateStateInspectionDiagnostics } from "./update-candidate-state.diagnostics.js";
import { withUpdateStateInspectionWork } from "./update-candidate-state.process.js";
import type { readUpdateStateDatabaseSizes } from "./update-candidate-state.sizes.js";

export async function runUpdateStateInspectionWorker(params: {
  input: { stateDir: string; config: OpenClawConfig; env?: NodeJS.ProcessEnv } & Record<
    string,
    unknown
  >;
  nodeRunner: string;
  root?: string;
  signal?: AbortSignal;
  sourceEnv: NodeJS.ProcessEnv;
  stagingRoot: string;
  databases: Awaited<ReturnType<typeof readUpdateStateDatabaseSizes>>;
  timeoutMs?: number;
  readOnlySource?: string;
}) {
  const workerUrl = resolveRuntimeWorkerUrl({
    ...(params.readOnlySource
      ? runtimeProcessEntrypoints.sqliteReadOnly
      : runtimeProcessEntrypoints.updateCandidateState),
    root: params.root,
  });
  const sourceTsconfigPath = /\.[cm]?ts$/.test(fileURLToPath(workerUrl))
    ? fileURLToPath(new URL("../../tsconfig.json", workerUrl))
    : undefined;
  const inspection = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase:
      params.input.mode === "versions" ? "schema inspection startup" : "shared database discovery",
    paths: params.readOnlySource
      ? [params.readOnlySource]
      : params.input.mode === "versions"
        ? params.databases.map((database) => database.path)
        : [path.resolve(params.input.stateDir, "state", "openclaw.sqlite")],
  });
  try {
    const result = await withUpdateStateInspectionWork(
      () =>
        withUpdateCandidateIoBudget(
          {
            directory: params.stagingRoot,
            bytes: params.databases.reduce(
              (total, database) => total + Number(database.sizeBytes ?? 0),
              0,
            ),
            timeoutMs: Math.max(
              params.timeoutMs ?? 0,
              resolveAggregateSqliteInspectionTimeoutMs(
                "state schema inspection",
                params.databases,
              ),
            ),
            signal: params.signal,
            nodeRunner: params.nodeRunner,
            env: params.sourceEnv,
          },
          (signal) =>
            runUtf8CommandWithTimeout(
              [
                params.nodeRunner,
                ...resolveRuntimeWorkerArgv(workerUrl, params.nodeRunner),
                ...(params.readOnlySource
                  ? [SQLITE_READONLY_CHILD_ARG, "sync", params.readOnlySource, params.stagingRoot]
                  : []),
              ],
              {
                cwd: os.tmpdir(),
                input: params.readOnlySource
                  ? undefined
                  : JSON.stringify({
                      ...params.input,
                      env: {
                        HOME: params.sourceEnv.HOME,
                        OPENCLAW_HOME: params.sourceEnv.OPENCLAW_HOME,
                        USERPROFILE: params.sourceEnv.USERPROFILE,
                        OPENCLAW_AGENT_DIR: params.sourceEnv.OPENCLAW_AGENT_DIR,
                        PI_CODING_AGENT_DIR: params.sourceEnv.PI_CODING_AGENT_DIR,
                      },
                    }),
                baseEnv: params.sourceEnv,
                env: {
                  XDG_CACHE_HOME: params.stagingRoot,
                  ...(sourceTsconfigPath ? { TSX_TSCONFIG_PATH: sourceTsconfigPath } : {}),
                },
                killGraceMs: 500,
                killProcessTree: true,
                maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
                outputCapture: { stdout: "head", stderr: "discard" },
                terminateOnOutputLimit: { stdout: true },
                onOutputChunk: inspection.onOutputChunk,
                signal,
              },
            ),
        ),
      params.signal,
    );
    return { ...result, stderr: inspection.stderr(), inspection };
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw inspection.failure(error);
    }
    params.signal?.throwIfAborted();
    throw inspection.failure(error);
  }
}

export function parseUpdateStateInspectionWorker<T>(
  result: Awaited<ReturnType<typeof runUpdateStateInspectionWorker>>,
  schema: z.ZodType<T>,
): T {
  if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
    const signal = result.signal ? `, signal ${result.signal}` : "";
    throw result.inspection.failure(
      result.stderr ||
        (result.outputLimitExceeded ? "Worker output exceeded its capture limit" : result.stdout),
      `${result.termination}${signal}`,
    );
  }
  try {
    return schema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw result.inspection.failure(error);
  }
}
