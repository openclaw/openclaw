import { acquireDoctorGatewayMaintenanceOwner } from "../commands/doctor-maintenance-foreground.js";
import { defaultRuntime } from "../runtime.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { stopSupervisedPredecessorGateway } from "./update-candidate-predecessor-stop.js";
import type { UpdateDatabaseGenerations } from "./update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "./update-doctor-result.js";

/** Keep the original capture through the stop receipt and Doctor, not a post-stop baseline. */
export async function withUpdateDoctorPredecessor<T>(
  input: {
    runId: string;
    repair: boolean;
    databaseGenerations?: UpdateDatabaseGenerations;
    databasePluginOwners?: import("./database-engine/port-descriptor.js").DatabasePortPluginOwners;
  },
  params: {
    root: string;
    assertCurrent: () => void;
    serviceInspectionBudget?: () => number | undefined;
    warn: (message: string) => void;
  },
  operation: (capture: ReturnType<typeof createUpdateDoctorDatabaseWriteCapture>) => Promise<T>,
): Promise<T> {
  let owner: Awaited<ReturnType<typeof acquireDoctorGatewayMaintenanceOwner>> | undefined;
  const assertCurrent = () => {
    owner?.assertCurrent();
    params.assertCurrent();
  };
  params.assertCurrent();
  const signal = getAsyncWorkSignal();
  const capture = createUpdateDoctorDatabaseWriteCapture(input.databaseGenerations, {
    env: process.env,
    root: params.root,
    signal: signal ?? new AbortController().signal,
    pluginOwners: input.databasePluginOwners,
    assertCurrent,
    warn: params.warn,
  });
  // Admission is read-only while the predecessor can still be serving. The
  // receipt writer acquires physical maintenance ownership after native stop.
  await capture?.admit();
  try {
    await stopSupervisedPredecessorGateway(input, {
      ...params,
      assertCurrent,
      async runReceipt(write) {
        owner = await acquireDoctorGatewayMaintenanceOwner(
          resolveOpenClawStateSqlitePath(),
          process.env,
          {
            options: { repair: true },
            runtime: defaultRuntime,
            assertCurrent: params.assertCurrent,
            signal,
            deadlineMs: (() => {
              const remaining = params.serviceInspectionBudget?.();
              return remaining === undefined ? undefined : performance.now() + remaining;
            })(),
          },
        );
        return owner.run(async () => {
          await (capture ? capture.run(write) : write());
        });
      },
    });
    assertCurrent();
    const run = () => operation(capture);
    return await (owner ? owner.run(run) : run());
  } finally {
    await owner?.release();
  }
}
