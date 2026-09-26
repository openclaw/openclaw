import type { getAuthoredConfigSecretRef } from "../../config/resolution-facts.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../../infra/runtime-worker-url.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createPluginSourceCaptureRoot } from "../../plugins/plugin-source-capture-directory.js";
import type { planOpenClawModelsJsonSource } from "../models-config.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "../prepared-model-catalog-worker.js";

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

export function createCatalogInspectionPool(env: NodeJS.ProcessEnv) {
  const capture = createPluginSourceCaptureRoot(resolveStateDir(env), "catalog-inspection-");
  const workerUrl = new URL("./prepared-model-catalog-inspection.worker.ts", import.meta.url);
  const pool = new WorkerTaskPool<
    CatalogInspectionTask,
    PreparedModelWorkerResult & { inspection: CatalogInspection }
  >({
    workerUrl,
    maxWorkers: 1,
    idleTimeoutMs: 0,
    restartOnError: false,
    prepareWorker: () => ({
      releaseResources: capture.release,
      options: {
        env,
        execArgv: [
          ...resolveRuntimeWorkerThreadExecArgv(workerUrl),
          "--experimental-test-module-mocks",
        ],
        workerData: {
          sourceCaptureDirectory: capture.directory,
          sourceCaptureManagedRoot: capture.managedRoot,
        },
      },
    }),
  });
  return { pool, captureDirectory: capture.directory };
}
