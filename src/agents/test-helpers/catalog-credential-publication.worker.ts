import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureAuthProfileCredentialCommits } from "../../state/user-model-account-authority.js";
import { writeAuthProfileJsonCell } from "../auth-profiles/sqlite-json-write.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";

serveWorkerTasks(async (value) => {
  const input = value as { path: string; store: AuthProfileStore };
  const captured = await captureAuthProfileCredentialCommits(async () => {
    const database = openOpenClawStateDatabase({ path: input.path });
    runOpenClawStateWriteTransaction(
      () => writeAuthProfileJsonCell(database.db, "store", "shared-state", input.store),
      { database },
    );
    return { status: "failed" as const, error: "catalog failed after credential refresh" };
  });
  return { ...captured.result, authCredentials: captured.receipts };
});
