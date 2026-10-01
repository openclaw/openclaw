import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { fleetOperations } from "./registry.worker.js";

export type FleetRegistryWriteOperations = WorkerOperations<typeof fleetOperations>;
