import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawConfig } from "../types.js";
import type { SessionStoreTargetInventoryResult } from "./session-store-target-inventory.js";
import { captureSessionStoreTargetInventory } from "./session-store-target-routing.js";
import {
  prepareSessionStoreCandidatesInWorker,
  withSessionHistoryWorkerReadCandidates,
} from "./session-transcript-worker-resources.js";
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
  const captured = captureSessionStoreTargetInventory(
    config,
    listConfiguredSessionStoreAgentIds(config),
    process.env,
    "configured",
  );
  const { env } = captured;
  const context = captureOpenClawStateReadWorkerContext({ env });
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  const assertCurrent = () => {
    assertCallerCurrent?.();
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  assertCurrent();
  // SAFETY: the inventory request always returns its captured selection with qualified candidates.
  const prepared = (await prepareSessionStoreCandidatesInWorker({ inventory: true, ...captured }))
    .inventory!;
  assertCurrent();
  registryRead.assertCurrent();
  const { candidates } = prepared;
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
  try {
    await prepareSessionStoreCandidatesInWorker({
      validate: {
        candidates,
        sources: candidates.flatMap(({ path, identity }) => (identity ? [{ path, identity }] : [])),
      },
    });
  } catch (error) {
    throw new Error(
      kind === "status"
        ? "Session store changed while reading cold storage status. Retry the request."
        : "Session store changed during cold maintenance",
      { cause: error },
    );
  }
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
              readIdentity: reads[index]!.readIdentity,
              readCustody: reads[index]!.readCustody,
            }))
          : [],
      ),
    assertCallerCurrent,
  );
  return { stores, assertCurrent };
}
