import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "../../infra/errno.js";
import { statIfExists } from "../../infra/path-existence.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import type { OpenClawConfig } from "../types.js";
import { resolveSessionArtifactDirectory } from "./paths.js";
import { withSessionColdStorageInventory } from "./session-cold-storage-targets.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";

async function fileBytes(pathname: string): Promise<number> {
  return (await statIfExists(pathname))?.size ?? 0;
}

export async function getSessionColdStorageStatus(config: OpenClawConfig) {
  const { result } = await withSessionColdStorageInventory(
    config,
    "status",
    async (inventory, env, assertCurrent) => {
      const stores = inventory.agents.flatMap(({ reads }) =>
        reads
          .filter(
            ({ database }) =>
              !isIncognitoOpenClawAgentSqlitePath(database.path, {
                agentId: database.agentId,
                env,
              }),
          )
          .map(({ database, target }) =>
            Object.assign({}, database, { env, storePath: target.storePath }),
          ),
      );
      return withSessionHistoryWorkerDatabases(stores, async (owners) => {
        const results = await Promise.allSettled(
          stores.map(async ({ agentId, storePath }, index) => {
            const owner = owners[index]!;
            const counts = await owner.readColdStorageInventory({ env });
            assertCurrent();
            owner.assertCurrent();
            const directory = path.join(resolveSessionArtifactDirectory(storePath), "cold");
            const files =
              (await fs.readdir(directory, { withFileTypes: true }).catch(ignoreMissingPath)) ?? [];
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
    },
  );
  return result;
}
