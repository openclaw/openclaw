import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { operatorApprovalOperations } from "./operator-approval-store.operations.js";

export type OperatorApprovalWorkerOperations = WorkerOperations<typeof operatorApprovalOperations>;
