import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import { selectGatewayRestartHandoffRowSync } from "./restart-handoff.js";
import type { EngineConnection } from "./sql-connection.js";

export const restartHandoffReadOperations = {
  "restartLifecycle.readHandoff": (_input: undefined, database) => ({
    type: "restartLifecycle.readHandoff" as const,
    row: selectGatewayRestartHandoffRowSync(database),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;
