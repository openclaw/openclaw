import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import type { UpdateRepairParams } from "./update-repair-protocol.js";

export async function withRepairExecutor<T>(
  params: UpdateRepairParams,
  operation: (params: UpdateRepairParams) => Promise<T>,
  installRoot = params.target.installRoot,
): Promise<T> {
  const control = path.join(path.dirname(installRoot), "executor-control");
  await fs.mkdir(control, { recursive: true, mode: 0o700 });
  const databasePath = path.join(control, "managed-update-handoffs.sqlite");
  const identity = createManagedHandoffLeaseDatabase(databasePath)(true, () =>
    captureManagedUpdateLeaseDatabaseIdentity(databasePath),
  );
  const runId = params.runId ?? randomUUID();
  return await withUpdateCommandExecutor(
    runId,
    async (executor) => {
      const executorFence = await executor.enter(installRoot);
      return await operation({ ...params, runId, executorFence });
    },
    { existingAuthority: { ...identity, installKey: installRoot } },
  );
}
