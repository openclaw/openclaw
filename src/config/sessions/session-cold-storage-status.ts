import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawConfig } from "../types.js";
import { resolveSessionArtifactDirectory } from "./paths.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { listConfiguredSessionStoreAgentIds } from "./targets.js";

async function fileBytes(pathname: string): Promise<number> {
  try {
    return (await fs.stat(pathname)).size;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

export async function getSessionColdStorageStatus(config: OpenClawConfig) {
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
  const assertSnapshotCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
    registryRead.assertCurrent();
    if (!source.isCurrent()) {
      throw new Error(
        "Session store changed while reading cold storage status. Retry the request.",
      );
    }
  };
  const result = await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const assertCurrent = () => {
      assertSnapshotCurrent();
      discovery.assertCurrent();
    };
    const registry = await registryRead.read();
    assertCurrent();
    const inventory = await discovery.readTargetInventory({
      ...prepared,
      registeredDatabases:
        registry.result.status === "available"
          ? registry.result.entries
          : { status: "unavailable" },
    });
    assertCurrent();
    if (inventory.kind === "session-target-registry-required") {
      throw new Error("Cold storage inventory did not receive its registry snapshot");
    }
    const stores = inventory.agents.flatMap(({ reads }) =>
      reads
        .filter(
          ({ database }) =>
            !isIncognitoOpenClawAgentSqlitePath(database.path, { agentId: database.agentId, env }),
        )
        .map(({ database, target }) =>
          Object.assign({}, database, { env, storePath: target.storePath }),
        ),
    );
    return withSessionHistoryWorkerDatabases(stores, async (owners) => {
      const readers = new Map(stores.map((store, index) => [store.path, owners[index]!]));
      const results = await Promise.allSettled(
        stores.map(async ({ agentId, path: databasePath, storePath }) => {
          const owner = readers.get(databasePath);
          const counts = await owner!.readColdStorageInventory({ env });
          assertCurrent();
          owner!.assertCurrent();
          const directory = path.join(resolveSessionArtifactDirectory(storePath), "cold");
          const files = await fs
            .readdir(directory, { withFileTypes: true })
            .catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return [];
              }
              throw error;
            });
          const archiveBytes = (
            await Promise.all(
              files
                .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl.zst"))
                .map((entry) => fileBytes(path.join(directory, entry.name))),
            )
          ).reduce((sum, bytes) => sum + bytes, 0);
          const { hotTranscripts, coldTranscripts, embeddedArchiveBytes } = counts;
          return {
            agentId,
            storePath,
            hotTranscripts,
            coldTranscripts,
            embeddedArchiveBytes,
            databaseBytes: await fileBytes(storePath),
            walBytes: await fileBytes(`${storePath}-wal`),
            archiveBytes,
          };
        }),
      );
      assertCurrent();
      return results.map((settled) => {
        if (settled.status === "rejected") {
          throw settled.reason;
        }
        return settled.value;
      });
    });
  });
  assertSnapshotCurrent();
  return result;
}
