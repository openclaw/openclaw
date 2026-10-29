import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
} from "../state/openclaw-state-maintenance-context.js";
import {
  runtimeProcessEntrypoints,
  SQLITE_READONLY_CHILD_ARG,
} from "./runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { resolveAggregateSqliteInspectionTimeoutMs } from "./sqlite-readonly-worker.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import { withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import {
  createUpdateStateInspectionDiagnostics,
  type UpdateStateInspectionProgress,
} from "./update-candidate-state.diagnostics.js";
import {
  withStateInspectionCleanup,
  withUpdateStateInspectionWork,
} from "./update-candidate-state.process.js";
import {
  readUpdateStateDatabaseSizes,
  readUpdateStateDatabaseSizesInProcess,
} from "./update-candidate-state.sizes.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";
import { isPublicUpdateFailureCode } from "./update-failure-public-codes.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

// Worker progress replaces these labels once the selected step reports its own phase.
const WORKER_STARTUP_PHASES = new Map<unknown, string>([
  ["versions", "schema inspection startup"],
  ["database-generations", "database generation verification"],
  ["database-backup", "database backup"],
  ["database-restore-preparation", "database restore preparation"],
  ["runtime-retention", "runtime dependency inventory"],
]);

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
  sources?: readonly string[];
  ioBudget?: "deadline";
  /** Best-effort callers continue after failure and compose their own guidance. */
  retryAdvice?: boolean;
  maxOutputBytes?: number;
  onProgress?: (progress: UpdateStateInspectionProgress) => void;
}) {
  const selectedUrl = resolveRuntimeWorkerUrl({
    ...(params.readOnlySource
      ? runtimeProcessEntrypoints.sqliteReadOnly
      : runtimeProcessEntrypoints.updateCandidateState),
    root: params.root,
  });
  // Default inspection belongs to this updater; explicit roots select the target's runtime.
  const source =
    params.root === undefined
      ? captureRuntimeWorkerSource(selectedUrl)
      : { moduleUrl: selectedUrl };
  const workerUrl = source.moduleUrl;
  const sourceTsconfigPath = /\.[cm]?ts$/.test(fileURLToPath(workerUrl))
    ? fileURLToPath(new URL("../../tsconfig.json", workerUrl))
    : undefined;
  const inspection = createUpdateStateInspectionDiagnostics({
    operation: "State schema inspection",
    phase: WORKER_STARTUP_PHASES.get(params.input.mode) ?? "shared database discovery",
    // Size admission omits missing files, so callers that verify absence name their full scope.
    paths: params.readOnlySource
      ? [params.readOnlySource]
      : (params.sources ??
        (params.input.mode === "discover"
          ? [path.resolve(params.input.stateDir, "state", "openclaw.sqlite")]
          : params.databases.map((database) => database.path))),
    retryAdvice: params.retryAdvice,
    onProgress: params.onProgress,
  });
  try {
    const timeoutMs = Math.max(
      params.timeoutMs ?? 0,
      resolveAggregateSqliteInspectionTimeoutMs("state schema inspection", params.databases),
    );
    const run = (signal: AbortSignal | undefined) =>
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
                includeLocalStoreVersions: true,
                includeClientCredentialStoreVersion: true,
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
          maxOutputBytes: { stdout: params.maxOutputBytes ?? 1024 * 1024, stderr: 20_000 },
          outputCapture: { stdout: "head", stderr: "discard" },
          terminateOnOutputLimit: { stdout: true },
          onOutputChunk: inspection.onOutputChunk,
          signal,
          ...(params.ioBudget === "deadline" ? { timeoutMs } : {}),
        },
      );
    const work = withUpdateStateInspectionWork(
      () =>
        params.ioBudget === "deadline"
          ? run(params.signal)
          : withUpdateCandidateIoBudget(
              {
                directory: params.stagingRoot,
                bytes: params.databases.reduce(
                  (total, database) => total + Number(database.sizeBytes ?? 0),
                  0,
                ),
                timeoutMs,
                signal: params.signal,
              },
              run,
            ),
      params.signal,
    );
    source.runtimeGeneration?.retain(work, async () => {
      await work.catch((error: unknown) => {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
      });
    });
    const result = await work;
    return { ...result, stderr: inspection.stderr(), inspection };
  } catch (error) {
    if (!hasCommandProcessCleanupError(error)) {
      params.signal?.throwIfAborted();
    }
    throw inspection.failure(error);
  }
}

export function parseUpdateStateInspectionWorker<T>(
  result: Awaited<ReturnType<typeof runUpdateStateInspectionWorker>>,
  schema: z.ZodType<T>,
): T {
  if (result.code !== 0 || result.termination !== "exit" || result.outputLimitExceeded) {
    const signal = result.signal ? `, signal ${result.signal}` : "";
    const failure = result.inspection.failure(
      result.stderr || (result.outputLimitExceeded ? "" : result.stdout),
      `${result.outputLimitExceeded ? "output-limit" : result.termination}${signal}`,
    );
    const code =
      !result.outputLimitExceeded && result.stderr.split(/\r?\n/u).find(isPublicUpdateFailureCode);
    throw code ? Object.assign(failure, { code }) : failure;
  }
  try {
    return schema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw result.inspection.failure(error);
  }
}

/** Raw fingerprint reads need their own process so descriptor closes cannot release caller locks. */
export async function readUpdateDatabaseGenerationsIsolated(
  paths: readonly string[],
  options: UpdateDatabaseGenerationReadOptions = {},
): Promise<UpdateDatabaseGenerations> {
  return (await inspectUpdateDatabaseGenerations(paths, options, false)).committed;
}

type UpdateDatabaseGenerationReadOptions = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  acquisition?: UpdateRecoveryCaptureAcquisition;
  retryAdvice?: boolean;
  pluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
};

export async function readUpdateDatabaseGenerationPairIsolated(
  paths: readonly string[],
  options: UpdateDatabaseGenerationReadOptions = {},
): Promise<import("./update-database-generations.js").UpdateDatabaseGenerationPair> {
  return inspectUpdateDatabaseGenerations(paths, options, true);
}

async function inspectUpdateDatabaseGenerations(
  paths: readonly string[],
  options: UpdateDatabaseGenerationReadOptions,
  paired: boolean,
): Promise<import("./update-database-generations.js").UpdateDatabaseGenerationPair> {
  const scope = getOpenClawDatabaseMaintenanceScope();
  const maintenanceOwner =
    options.acquisition?.mode === "maintenance-owner" &&
    paths.every((pathname) => maintenanceOwnerHasSourceCustody(scope, pathname));
  const { root, timeoutMs, env: sourceEnv = process.env, signal: caller } = options;
  const controller = new AbortController();
  const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
  const stagingRoot = await createSqliteSnapshotStagingDirectory(
    resolvePrivateSqliteSnapshotStagingRoot(sourceEnv),
    root !== undefined,
    signal,
  );
  const inspection = withStateInspectionCleanup(stagingRoot, async () => {
    const worker = { nodeRunner: process.execPath, sourceEnv, stagingRoot, timeoutMs, signal };
    const inventorySchema = z.record(z.string(), z.nullable(z.string().regex(/^[a-f0-9]{64}$/u)));
    const generations = parseUpdateStateInspectionWorker(
      await runUpdateStateInspectionWorker({
        ...worker,
        root,
        retryAdvice: options.retryAdvice,
        sources: paths,
        ...(maintenanceOwner ? { ioBudget: "deadline" as const } : {}),
        input: {
          mode: "database-generations",
          generationFormat: paired ? "paired" : "committed",
          paths,
          ...(options.pluginOwners ? { pluginOwners: options.pluginOwners } : {}),
          stateDir: resolveStateDir(sourceEnv),
          config: {},
        },
        databases: maintenanceOwner
          ? await readUpdateStateDatabaseSizesInProcess(paths, signal)
          : await readUpdateStateDatabaseSizes(paths, worker),
      }),
      paired
        ? z.object({
            committed: inventorySchema,
            physical: inventorySchema,
            emptyReaderAlternates: z.record(z.string(), z.string()),
          })
        : inventorySchema.transform((committed) => ({
            committed,
            physical: committed,
            emptyReaderAlternates: {},
          })),
    );
    if (
      [generations.committed, generations.physical].some(
        (inventory) =>
          Object.keys(inventory).length !== new Set(paths).size ||
          paths.some((pathname) => !Object.hasOwn(inventory, pathname)),
      )
    ) {
      throw new Error("Database generation worker did not return the supplied inventory.");
    }
    return generations;
  });
  return retainSnapshotWork(inspection, () => controller.abort());
}
