import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerEnvironmentStore } from "./store.js";

/** Set up a valid persisted binding through the real environment/repository owners. */
export async function bindRepositoryDiskForTest(
  repository: SessionRepositoryWorkspaceRecord,
  sessionId: string,
  pathname?: string,
) {
  const database = openOpenClawStateDatabase(pathname ? { path: pathname } : {});
  const placements = createWorkerSessionPlacementStore({ database });
  const active = await advancePlacementFixtureToActive(placements, database, {
    sessionId,
    sessionKey: repository.sessionKey,
    agentId: repository.agentId,
    executionMode: "worker-turn",
  });
  const environments = await createWorkerEnvironmentStore({ database });
  const environment = environments.get(active.environmentId)!;
  if (!environment.leaseId) {
    throw new Error("Fixture requires an allocated environment");
  }
  const resourceReceipt = {
    version: 1 as const,
    leaseId: environment.leaseId,
    identity: { diskId: "original-disk" },
  };
  await environments.recordResourceReceipt({
    environmentId: environment.environmentId,
    provisionOperationId: environment.provisionOperationId,
    receipt: resourceReceipt,
    assertCurrent() {},
  });
  return createSessionRepositoryWorkspaceStore({ path: database.path }).bindDisk({
    workspaceId: repository.workspaceId,
    expectedRevision: repository.revision,
    diskAuthority: { environmentId: active.environmentId, resourceReceipt },
    assertCurrent() {},
  });
}
