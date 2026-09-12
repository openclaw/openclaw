import path from "node:path";
import { expect } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  type snapshotUpdateCandidateState,
  UpdateCandidateSnapshotInventorySchema,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";

type SnapshotInput = Omit<
  Parameters<typeof snapshotUpdateCandidateState>[0],
  "pluginPlanPath" | "databaseInventory"
>;
type Admission = Pick<
  Parameters<typeof snapshotUpdateCandidateState>[0],
  "pluginPlanPath" | "databaseInventory"
>;

function runWorker(input: SnapshotInput, mode: "inventory" | "snapshot", admitted?: Admission) {
  // Backup/VACUUM cannot be cancelled in-process; join the worker before fixture cleanup.
  return runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      input: JSON.stringify({ ...input, mode, ...admitted }),
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
}

export async function inventoryUpdateCandidateStateWorker(
  input: SnapshotInput,
): Promise<Admission> {
  const result = await runWorker(input, "inventory");
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  const inventory = UpdateCandidateSnapshotInventorySchema.parse(
    JSON.parse(result.stdout.toString("utf8")),
  );
  return {
    pluginPlanPath: path.join(input.targetStateDir, inventory.pluginPlan),
    databaseInventory: [...inventory.databases.keys()],
  };
}

export async function runUpdateCandidateSnapshotWorker(input: SnapshotInput) {
  const admitted = await inventoryUpdateCandidateStateWorker(input);
  const result = await runWorker(input, "snapshot", admitted);
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return UpdateCandidateStateSnapshotSchema.parse(JSON.parse(result.stdout.toString("utf8")))
    .versions;
}
