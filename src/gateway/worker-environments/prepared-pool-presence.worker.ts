import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../../state/worker-operation-registry.js";
import { writePreparedPoolPresenceDemandInDatabase } from "./prepared-pool-presence-store.worker.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";

export const preparedPoolPresenceOperations = {
  "preparedPoolPresence.write": (value: PreparedPoolPresenceDemand | null, { writeAdmitted }) =>
    writeAdmitted(({ db }) => writePreparedPoolPresenceDemandInDatabase(db, value), {
      operationLabel: "prepared-pool.presence-demand.write",
    }),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type PreparedPoolPresenceWorkerOperations = WorkerOperations<
  typeof preparedPoolPresenceOperations
>;
