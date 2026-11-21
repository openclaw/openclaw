import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

/** Reject only this fixture's telemetry success writes while retaining real reads. */
export function blockTelemetryPersistence(): () => void {
  const databasePath = resolveOpenClawStateSqlitePath();
  let blocked = true;
  probe.command(workerStore, (command, executeOptions, scope, context) =>
    blocked &&
    context.admission.databasePath === databasePath &&
    command.type === "telemetry.persistSuccess"
      ? Promise.reject(new Error("Telemetry persistence unavailable"))
      : scope.execute(command, executeOptions),
  );
  return () => {
    blocked = false;
  };
}
