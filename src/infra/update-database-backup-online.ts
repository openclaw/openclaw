import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";

type CaptureEntry = {
  path: string;
  snapshotPath: string;
  engine?: "postgres";
  exportDirectory?: string;
};
type OnlineCapture = {
  directory: string;
  databases: CaptureEntry[];
  sourceGenerations: Record<string, string | null>;
  sourceDigests?: Record<string, string>;
};

export type OnlineCaptureInput = {
  /**
   * Capture PostgreSQL stores while the Gateway serves and skip SQLite stores. Each store records
   * the generation and reuse digest read inside its own capture snapshot, never a before/after pair.
   */
  postgresOnline?: boolean;
  /**
   * This run's online capture in the same directory. Under ownership a store whose live digest
   * still matches keeps its online capture; any other store is captured again.
   */
  reuse?: OnlineCapture;
};

/** The capture under ownership writes into its online capture's directory; others create theirs. */
export async function prepareUpdateDatabaseBackupDirectory(
  directory: string,
  reuse: OnlineCapture | undefined,
) {
  if (!reuse) {
    await createPrivateSqliteDirectory(directory);
  } else if (path.resolve(reuse.directory) !== (await fs.realpath(directory))) {
    throw new Error("An online capture is reused only in its own directory.");
  }
}

/** Drop one store's online capture: its server schema first, then its local files. */
async function discardOnlineCaptureEntry(entry: CaptureEntry, config: OpenClawConfig) {
  if (entry.exportDirectory) {
    const { discardPostgresSchemaCaptures } = await import("../snapshot/database-backup.js");
    await discardPostgresSchemaCaptures(config, [entry.exportDirectory]);
    await fs.rm(entry.exportDirectory, { recursive: true, force: true });
  }
  await fs.rm(entry.snapshotPath, { force: true });
}

/**
 * Updates capture each PostgreSQL store while the Gateway serves, recording the store's
 * generation and reuse digest from that capture's own snapshot; SQLite stores (local
 * credentials and journals even on PostgreSQL installs) are captured after the stop as before.
 * Under exclusive ownership a store keeps its online capture only if its live digest still
 * matches; any other store's online capture is dropped and the store is captured again, so no
 * acknowledged write is lost.
 */
export function createOnlineUpdateCapture(
  input: OnlineCaptureInput & { config: OpenClawConfig; pluginOwners?: DatabasePortPluginOwners },
  engines: ReadonlyMap<string, { engine: string }>,
) {
  const digests: Record<string, string> = {};
  const unclaimed = new Map(input.reuse?.databases.map((entry) => [entry.path, entry] as const));
  return {
    record(
      sourcePath: string,
      observed: { generation: string; digest: string } | undefined,
      generations: Record<string, string | null>,
    ) {
      if (!input.postgresOnline) {
        return;
      }
      if (!observed) {
        throw new Error(`Online capture did not observe its snapshot: ${sourcePath}`);
      }
      generations[sourcePath] = observed.generation;
      digests[sourcePath] = observed.digest;
    },
    /** True when this pass leaves the store alone: SQLite while serving, or a kept capture. */
    async keep(
      sourcePath: string,
      backup: {
        databases: CaptureEntry[];
        sourceGenerations: Record<string, string | null>;
        warnings: string[];
      },
    ) {
      if (input.postgresOnline) {
        return engines.get(sourcePath)?.engine !== "postgres";
      }
      const entry = unclaimed.get(sourcePath);
      if (!entry) {
        return false;
      }
      unclaimed.delete(sourcePath);
      const generation = input.reuse?.sourceGenerations[sourcePath];
      const expected = input.reuse?.sourceDigests?.[sourcePath];
      if (entry.engine === "postgres" && generation && expected) {
        const { digestPostgresBackup } = await import("../snapshot/database-backup.js");
        // An unreadable digest is a change: the store is captured again.
        const live = await digestPostgresBackup(sourcePath, input.config, input.pluginOwners).catch(
          () => undefined,
        );
        if (live === expected) {
          backup.databases.push(entry);
          backup.sourceGenerations[sourcePath] = generation;
          backup.warnings.push(`Kept the capture taken while the Gateway served: ${sourcePath}`);
          return true;
        }
      }
      await discardOnlineCaptureEntry(entry, input.config);
      return false;
    },
    /** Drops online captures of stores the inventory no longer lists; returns the digests. */
    async finish() {
      for (const entry of unclaimed.values()) {
        await discardOnlineCaptureEntry(entry, input.config);
      }
      return input.postgresOnline ? { sourceDigests: digests } : {};
    },
  };
}
