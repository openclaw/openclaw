import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import type { getAuthoredConfigSecretRef } from "../../config/resolution-facts.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { startPluginSourceCaptureRoot } from "../../plugins/plugin-source-capture-directory.js";
import type { planOpenClawModelsJsonSource } from "../models-config.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "../prepared-model-catalog-worker.types.js";

export type CatalogInspectionTask = PreparedModelCatalogWorkerTask & {
  inspection?: {
    existingAgentIds?: string[];
    provider?: string;
    expectedCredential?: string;
    failCatalog?: boolean;
    copyProbePath?: string;
  };
};

export type CatalogInspection = {
  sqliteCopies: number;
  copyHookObserved?: boolean;
  registeredAgentId?: string;
  foreignReleased?: boolean;
  runtimeFactsAbsent: boolean;
  sourceFactsAbsent: boolean;
  sameResolutionFacts: boolean;
  credentialMatches?: boolean;
  authoredRef?: ReturnType<typeof getAuthoredConfigSecretRef>;
  resolvedEnvRef?: ReturnType<typeof getAuthoredConfigSecretRef>;
  plans: Array<Awaited<ReturnType<typeof planOpenClawModelsJsonSource>>>;
};

export async function createCatalogInspectionPool(
  env: NodeJS.ProcessEnv,
  registerCleanup: (cleanup: () => Promise<void>) => void,
) {
  const capturedEnv = cloneEnvWithPlatformSemantics(env);
  const admission = startPluginSourceCaptureRoot(
    resolveStateDir(capturedEnv),
    "catalog-inspection-",
  );
  let releaseAttempt: Promise<void> | undefined;
  const releaseCapture = () => (releaseAttempt ??= admission.release());
  const closeCapture = async () => {
    const pending = releaseCapture();
    try {
      await pending;
    } catch (error) {
      if (releaseAttempt === pending) {
        releaseAttempt = undefined;
      }
      throw error;
    }
  };
  let cleanup = closeCapture;
  registerCleanup(() => cleanup());
  const workerUrl = new URL("./prepared-model-catalog-inspection.worker.ts", import.meta.url);
  let transferred = false;
  try {
    const capture = await admission.result;
    capture.assertCurrent();
    const pool = new WorkerTaskPool<
      CatalogInspectionTask,
      PreparedModelWorkerResult & { inspection: CatalogInspection }
    >({
      workerUrl,
      maxWorkers: 1,
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => {
        capture.assertCurrent();
        const prepared = {
          releaseResources: releaseCapture,
          options: {
            env: capturedEnv,
            execArgv: [
              ...resolveRuntimeWorkerThreadExecArgv(workerUrl),
              "--experimental-test-module-mocks",
            ],
            workerData: {
              sourceCaptureDirectory: capture.directory,
              sourceCaptureManagedRoot: capture.managedRoot,
            },
          },
        };
        transferred = true;
        return prepared;
      },
    });
    let closing: Promise<void> | undefined;
    const closePool = (error?: Error) =>
      (closing ??= (async () => {
        const failures: unknown[] = [];
        let joined = false;
        try {
          await pool.close(error);
          joined = true;
        } catch (closeError) {
          failures.push(closeError);
        }
        if (releaseAttempt || joined || !transferred) {
          try {
            await closeCapture();
          } catch (releaseError) {
            failures.push(releaseError);
          }
        }
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Catalog inspection cleanup failed", {
            cause: failures[0],
          });
        }
      })().finally(() => {
        closing = undefined;
      }));
    cleanup = closePool;
    return {
      pool: { run: pool.run.bind(pool), close: closePool },
      captureDirectory: capture.directory,
    };
  } catch (error) {
    try {
      await closeCapture();
    } catch (releaseError) {
      throw createSqliteLifecycleAggregateError(
        [error, releaseError],
        "Catalog inspection preparation failed",
        error,
      );
    }
    throw error;
  }
}
