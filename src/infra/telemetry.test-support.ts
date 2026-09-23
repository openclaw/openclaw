import { vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";

/** Reject only this fixture's telemetry success writes while retaining real reads. */
export function blockTelemetryPersistence(): () => void {
  const databasePath = resolveOpenClawStateSqlitePath();
  let blocked = true;
  const original = workerStore.runOpenClawStateWorkerOperation;
  vi.spyOn(workerStore, "runOpenClawStateWorkerOperation").mockImplementation(
    (context, operation, options) =>
      original(
        context,
        (scope) =>
          operation({
            execute: (command, executeOptions) =>
              blocked &&
              context.admission.databasePath === databasePath &&
              command.type === "telemetry.persistSuccess"
                ? Promise.reject(new Error("Telemetry persistence unavailable"))
                : scope.execute(command, executeOptions),
          }),
        options,
      ),
  );
  return () => {
    blocked = false;
  };
}
