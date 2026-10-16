import { vi } from "vitest";
import { z } from "zod";
import { createUpdateStateInspectionDiagnostics } from "../update-candidate-state.diagnostics.js";
import * as inspection from "../update-candidate-state.inspection.js";
import {
  discoverUpdateStateSchemaInspectionInProcess,
  UpdateStateSchemaInspectionPlanSchema,
} from "../update-candidate-state.js";
import * as databaseSizes from "../update-candidate-state.sizes.js";
import {
  createUpdateDatabaseBackup,
  createUpdateDatabaseBackupInProcess,
} from "../update-database-backup.js";

// Exercise the real capture owner in the fixture process; subprocess lifecycle
// is covered by the public-driver proof. Replace only the two transports.
export async function createUpdateDatabaseBackupWithFixtureTransport(
  input: Parameters<typeof createUpdateDatabaseBackup>[0],
) {
  const worker = vi.spyOn(inspection, "runUpdateStateInspectionWorker");
  const sizes = vi
    .spyOn(databaseSizes, "readUpdateStateDatabaseSizes")
    .mockImplementation((files, options) =>
      databaseSizes.readUpdateStateDatabaseSizesInProcess(files, options.signal),
    );
  worker.mockImplementation(async (params) => {
    const captured = {
      ...input,
      ...params.input,
      stagingRoot: params.stagingRoot,
      additionalPaths: z.array(z.string()).parse(params.input.additionalPaths),
      preserveSourceArtifacts: z.boolean().optional().parse(params.input.preserveSourceArtifacts),
      postgresOffline: z.boolean().optional().parse(params.input.postgresOffline),
    };
    let result;
    if (params.input.mode === "discover") {
      result = await discoverUpdateStateSchemaInspectionInProcess(captured);
    } else if (params.input.mode === "database-backup") {
      result = await createUpdateDatabaseBackupInProcess({
        ...captured,
        inspectionPlan: UpdateStateSchemaInspectionPlanSchema.parse(params.input.inspectionPlan),
      });
    } else {
      throw new Error(`Unexpected fixture capture mode: ${String(params.input.mode)}`);
    }
    return {
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
      stdout: JSON.stringify(result),
      stderr: "",
      inspection: createUpdateStateInspectionDiagnostics({
        operation: "State schema inspection",
        phase: String(params.input.mode),
        paths: captured.additionalPaths,
      }),
    };
  });
  try {
    return await createUpdateDatabaseBackup(input);
  } finally {
    worker.mockRestore();
    sizes.mockRestore();
  }
}
