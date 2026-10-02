import type { DatabaseSync } from "node:sqlite";
import type { DiagnosticReadOperations } from "../infra/sqlite-audit-record.read-contract.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

export const stateReadRegistry = createWorkerOperationRegistry<
  DiagnosticReadOperations,
  DatabaseSync
>({
  diagnostic: () =>
    import("../infra/sqlite-audit-record.kernel.js").then((m) => m.diagnosticReadOperations),
});
