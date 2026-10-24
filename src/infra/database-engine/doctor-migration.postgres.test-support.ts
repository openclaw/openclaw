import { withOpenClawStateReadOnlyLocation } from "../../state/openclaw-state-db-read-connection.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadLocation,
} from "../../state/openclaw-state-read.types.js";
import { stateBootstrapReadOperations } from "../../state/state-bootstrap-read.worker.js";
import { inspectGatewayOwnerLease } from "../gateway-owner-lease.worker.js";
import { withEngineStoreAdmission } from "./admission-scope.js";

export async function readInProcess(
  command: OpenClawStateReadCommand,
  source: OpenClawStateReadLocation,
) {
  const databasePath = source.context.admission.databasePath;
  if (command.type === "stateBootstrap.inspect" || command.type === "stateBootstrap.ownership") {
    return withEngineStoreAdmission(() =>
      withOpenClawStateReadOnlyLocation(
        ({ db }) => ({
          ok: true as const,
          sourceAdmitted: true as const,
          ...(command.type === "stateBootstrap.inspect"
            ? stateBootstrapReadOperations[command.type](command.input, db)
            : stateBootstrapReadOperations[command.type](command.input, db)),
        }),
        databasePath,
        source.location,
      ),
    );
  }
  if (command.type !== "gatewayOwnerLease.read") {
    throw new Error(`Unexpected fixture read: ${command.type}`);
  }
  const lease = withEngineStoreAdmission(() =>
    inspectGatewayOwnerLease({ ...source, databasePath }, () => {}, command.schemaMaintenance),
  );
  return { ok: true as const, type: command.type, sourceAdmitted: true as const, lease };
}
