import { runSupervisedOperationProcess } from "./supervised-operation.runner.js";

const [marker, operationId, executionId, databasePath] = process.argv.slice(2);
if (
  marker !== "--supervised-operation" ||
  !operationId ||
  !executionId ||
  !databasePath ||
  process.argv.length !== 6
) {
  throw new Error("Invalid private supervised operation invocation");
}
await runSupervisedOperationProcess(operationId, executionId, { path: databasePath }).catch(() => {
  // Canonical result belongs in SQL; losing storage is not a synthetic success.
  process.exitCode = 1;
});
