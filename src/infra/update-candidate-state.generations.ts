import { z } from "zod";
import { resolveStateDir } from "../config/paths.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  maintenanceOwnerHasSourceCustody,
} from "../state/openclaw-state-maintenance-context.js";
import { resolvePrivateSqliteSnapshotStagingRoot } from "./sqlite-private-directory.js";
import { retainSnapshotWork } from "./sqlite-readonly-location-cleanup.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";
import {
  parseUpdateStateInspectionWorker,
  runUpdateStateInspectionWorker,
} from "./update-candidate-state.inspection.js";
import { withStateInspectionCleanup } from "./update-candidate-state.process.js";
import {
  readUpdateStateDatabaseSizes,
  readUpdateStateDatabaseSizesInProcess,
} from "./update-candidate-state.sizes.js";
import type {
  UpdateDatabaseGenerationObservation,
  UpdateDatabaseGenerations,
} from "./update-database-generations.js";
import type { UpdateRecoveryCaptureAcquisition } from "./update-recovery-capture-acquisition.js";

const databaseGenerationSchema = z.string().regex(/^[a-f0-9]{64}$/u);
type UpdateDatabaseGenerationReadOptions = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  acquisition?: UpdateRecoveryCaptureAcquisition;
  retryAdvice?: boolean;
};

/** Raw fingerprint reads need their own process so descriptor closes cannot release caller locks. */
export function readUpdateDatabaseGenerationsIsolated(
  paths: readonly string[],
  options: UpdateDatabaseGenerationReadOptions = {},
): Promise<UpdateDatabaseGenerations> {
  return inspectUpdateDatabaseGenerations(
    paths,
    options,
    z.record(z.string(), databaseGenerationSchema.nullable()),
  );
}

/** Only Doctor requests alternates from its own candidate; older drivers still receive the flat inventory. */
export function readUpdateDatabaseGenerationObservationsIsolated(
  paths: readonly string[],
  options: UpdateDatabaseGenerationReadOptions,
): Promise<Record<string, UpdateDatabaseGenerationObservation>> {
  return inspectUpdateDatabaseGenerations(
    paths,
    options,
    z.record(
      z.string(),
      z.object({
        generation: databaseGenerationSchema.nullable(),
        emptyReaderAlternate: databaseGenerationSchema.optional(),
        rebuiltIndexAlternate: databaseGenerationSchema.optional(),
      }),
    ),
    true,
  );
}

async function inspectUpdateDatabaseGenerations<T>(
  paths: readonly string[],
  options: UpdateDatabaseGenerationReadOptions,
  schema: z.ZodType<Record<string, T>>,
  includeAlternates?: true,
): Promise<Record<string, T>> {
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
    const generations = parseUpdateStateInspectionWorker(
      await runUpdateStateInspectionWorker({
        ...worker,
        root,
        retryAdvice: options.retryAdvice,
        sources: paths,
        ...(maintenanceOwner ? { ioBudget: "deadline" as const } : {}),
        input: {
          mode: "database-generations",
          paths,
          ...(includeAlternates ? { includeAlternates } : {}),
          stateDir: resolveStateDir(sourceEnv),
          config: {},
        },
        databases: maintenanceOwner
          ? await readUpdateStateDatabaseSizesInProcess(paths, signal)
          : await readUpdateStateDatabaseSizes(paths, worker),
      }),
      schema,
    );
    if (
      Object.keys(generations).length !== new Set(paths).size ||
      paths.some((pathname) => !Object.hasOwn(generations, pathname))
    ) {
      throw new Error("Database generation worker did not return the supplied inventory.");
    }
    return generations;
  });
  return retainSnapshotWork(inspection, () => controller.abort());
}
