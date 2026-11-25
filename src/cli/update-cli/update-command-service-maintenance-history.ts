import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import type { ManagedServiceStopParams } from "./update-command-service-context-types.js";

/** Update-history records of one managed-service stop: its warnings and the stop itself. */
export function createGatewayMaintenanceHistory(
  params: Pick<ManagedServiceStopParams, "updateRun" | "warn">,
  assertCurrent: () => void,
) {
  const { updateRun } = params;
  let warningIndex = 0;
  return {
    warn: (message: string) => {
      assertCurrent();
      (params.warn ?? defaultRuntime.error)(message);
      const runId = updateRun?.runId ?? process.env[UPDATE_RUN_ID_ENV];
      if (runId) {
        try {
          recordUpdateRunStep(
            runId,
            {
              step: `warning:gateway-maintenance:${Date.now()}:${warningIndex++}`,
              status: "completed",
              endedAtMs: Date.now(),
              detail: message,
            },
            updateRun,
          );
        } catch {
          (params.warn ?? defaultRuntime.error)(
            "Could not record the Gateway maintenance warning in update history.",
          );
        }
      }
    },
    // Repair restarts only the stops an update recorded; a killed updater has nothing else to say.
    recordStop: (startedAtMs: number | undefined) => {
      if (!updateRun) {
        return;
      }
      try {
        recordUpdateRunStep(
          updateRun.runId,
          { step: "service-stop", status: "completed", startedAtMs, endedAtMs: Date.now() },
          updateRun,
        );
      } catch {
        (params.warn ?? defaultRuntime.error)(
          "Could not record the Gateway stop in update history; update repair may not restart it.",
        );
      }
    },
  };
}
