import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  acquireFleetCellOperationInDatabase,
  assertFleetCellOperationInDatabase,
  deleteFleetCellInDatabase,
  heartbeatFleetCellOperationInDatabase,
  releaseFleetCellOperationInDatabase,
  reserveFleetCellInDatabase,
  updateFleetCellImageInDatabase,
} from "./registry.kernel.js";
import type { FleetRegistryWriteOperations } from "./registry.types.js";

export function executeFleetRegistryCommand(
  command: SqliteWorkerCommand<FleetRegistryWriteOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): FleetRegistryWriteOperations[keyof FleetRegistryWriteOperations]["output"] {
  return runOpenClawStateWriteTransaction(({ db }) => {
    switch (command.type) {
      case "fleet.cell.reserve":
        assertFleetCellOperationInDatabase(
          db,
          command.input.tenantId,
          command.input.operationOwner,
        );
        return reserveFleetCellInDatabase(db, command.input);
      case "fleet.cell.updateImage":
        assertFleetCellOperationInDatabase(
          db,
          command.input.tenantId,
          command.input.operationOwner,
        );
        return updateFleetCellImageInDatabase(db, command.input.tenantId, command.input.image);
      case "fleet.cell.delete":
        assertFleetCellOperationInDatabase(
          db,
          command.input.tenantId,
          command.input.operationOwner,
        );
        return deleteFleetCellInDatabase(db, command.input.tenantId);
      case "fleet.operation.acquire":
        return acquireFleetCellOperationInDatabase(db, command.input);
      case "fleet.operation.heartbeat":
        return heartbeatFleetCellOperationInDatabase(db, command.input);
      case "fleet.operation.release":
        return releaseFleetCellOperationInDatabase(db, command.input);
    }
  }, options);
}
