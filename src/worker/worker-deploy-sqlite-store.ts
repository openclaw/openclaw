import "./worker-deploy-runtime.js";
import "../infra/sqlite-store.worker.js";

type SharedStateWorker = typeof import("../state/openclaw-state.worker.js");

// Agent-only carriers do not need the shared-state backend initialized.
export async function createSqliteWorkerBackend(
  ...args: Parameters<SharedStateWorker["createSqliteWorkerBackend"]>
) {
  const worker = await import("../state/openclaw-state.worker.js");
  return worker.createSqliteWorkerBackend(...args);
}

export async function openExistingSqliteWorkerBackend(
  ...args: Parameters<SharedStateWorker["openExistingSqliteWorkerBackend"]>
) {
  const worker = await import("../state/openclaw-state.worker.js");
  return worker.openExistingSqliteWorkerBackend(...args);
}
