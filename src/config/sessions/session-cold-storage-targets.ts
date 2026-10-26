import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawConfig } from "../types.js";
import {
  prepareSessionStoreTargetInventory,
  type SessionStoreTargetInventoryResult,
} from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { listConfiguredSessionStoreAgentIds } from "./targets.js";

export async function withSessionColdStorageInventory<T>(
  config: OpenClawConfig,
  kind: "status" | "maintenance",
  operation: (
    inventory: Extract<SessionStoreTargetInventoryResult, { kind: "session-target-inventory" }>,
    env: NodeJS.ProcessEnv,
    assertCurrent: () => void,
  ) => T | Promise<T>,
  assertCallerCurrent?: () => void,
) {
  const prepared = prepareSessionStoreTargetInventory(
    config,
    listConfiguredSessionStoreAgentIds(config),
    process.env,
    "configured",
  );
  const { env, candidates } = prepared;
  const context = captureOpenClawStateReadWorkerContext({ env });
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  const source = createOpenClawAgentDatabasePathMatcher();
  for (const candidate of candidates) {
    source(candidate.path, candidate.path);
  }
  const assertCurrent = () => {
    assertCallerCurrent?.();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    if (!source.isCurrent()) {
      throw new Error(
        kind === "status"
          ? "Session store changed while reading cold storage status. Retry the request."
          : "Session store changed during cold maintenance",
      );
    }
  };
  const result = await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const assertDiscoveryCurrent = () => {
      assertCurrent();
      registryRead.assertCurrent();
      discovery.assertCurrent();
    };
    const registry = await registryRead.read();
    assertDiscoveryCurrent();
    const inventory = await discovery.readTargetInventory({
      ...prepared,
      registeredDatabases:
        registry.result.status === "available"
          ? registry.result.entries
          : { status: "unavailable" },
    });
    assertDiscoveryCurrent();
    if (inventory.kind === "session-target-registry-required") {
      throw new Error(
        kind === "status"
          ? "Cold storage inventory did not receive its registry snapshot"
          : "Cold maintenance did not receive its registry snapshot",
      );
    }
    return operation(inventory, env, assertDiscoveryCurrent);
  });
  assertCurrent();
  registryRead.assertCurrent();
  return { result, assertCurrent };
}

export async function prepareSessionColdStorageTargets(
  config: OpenClawConfig,
  assertCallerCurrent?: () => void,
) {
  const { result: stores, assertCurrent } = await withSessionColdStorageInventory(
    config,
    "maintenance",
    (inventory, env) =>
      inventory.agents.flatMap(({ result, reads }) =>
        result.available
          ? result.targets.map((target, index) => ({
              databaseOptions: {
                ...reads[index]!.database,
                // Archive paths and restore cooldowns retain the configured SQLite locator.
                path: reads[index]!.target.storePath,
                env,
              },
              ownerStorePath: target.storePath,
            }))
          : [],
      ),
    assertCallerCurrent,
  );
  return { stores, assertCurrent };
}
