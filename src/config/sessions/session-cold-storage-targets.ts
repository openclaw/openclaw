import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { createOpenClawAgentDatabasePathMatcher } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawConfig } from "../types.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { listConfiguredSessionStoreAgentIds } from "./targets.js";

export async function prepareSessionColdStorageTargets(
  config: OpenClawConfig,
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
      throw new Error("Session store changed during cold maintenance");
    }
  };
  const stores = await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const registry = await registryRead.read();
    assertCurrent();
    registryRead.assertCurrent();
    discovery.assertCurrent();
    const inventory = await discovery.readTargetInventory({
      ...prepared,
      registeredDatabases:
        registry.result.status === "available"
          ? registry.result.entries
          : { status: "unavailable" },
    });
    assertCurrent();
    registryRead.assertCurrent();
    discovery.assertCurrent();
    if (inventory.kind === "session-target-registry-required") {
      throw new Error("Cold maintenance did not receive its registry snapshot");
    }
    return inventory.agents.flatMap(({ result, reads }) =>
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
    );
  });
  assertCurrent();
  registryRead.assertCurrent();
  return { stores, assertCurrent };
}
