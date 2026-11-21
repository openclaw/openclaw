import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PostgresCapturePrune } from "../snapshot/database-backup-core.worker.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import type { DatabasePortPluginOwners } from "./database-engine/port-descriptor.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import { measureUpdateStateFiles } from "./update-candidate-io.js";
import { markPrivateCapture, ONLINE_UPDATE_CAPTURE_NAME } from "./update-capture-paths.js";
import { findUpdateCaptureSpaceError } from "./update-capture-space.js";
import {
  checkOnlinePostgresExportSpace,
  checkUpdateDatabaseBackupSpace,
} from "./update-database-backup-space.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";

type CaptureEntry = UpdateDatabaseBackup["databases"][number];
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

/** Both capture passes share the online root that protects their server copies. */
export function resolveOnlineCapturePrune(directory: string): PostgresCapturePrune | undefined {
  const captureId = ONLINE_UPDATE_CAPTURE_NAME.exec(path.basename(directory))?.[1];
  return captureId
    ? {
        directoryPrefix: path.join(path.dirname(directory), "online-"),
        captureId,
        directorySuffix: ".databases",
      }
    : undefined;
}

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
  if (ONLINE_UPDATE_CAPTURE_NAME.test(path.basename(directory))) {
    await markPrivateCapture(directory);
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
function createOnlineUpdateCapture(
  input: OnlineCaptureInput & { config: OpenClawConfig; pluginOwners?: DatabasePortPluginOwners },
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
    /** Reuse an unchanged online capture under ownership. */
    async keep(
      sourcePath: string,
      backup: {
        databases: CaptureEntry[];
        sourceGenerations: Record<string, string | null>;
        warnings: string[];
      },
    ) {
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

/** Account for reused captures before admitting the remaining writes. */
export async function planUpdateCaptureStores(
  input: Parameters<typeof createOnlineUpdateCapture>[0] & {
    postgresOffline?: boolean;
    stopped?: boolean;
  },
  directory: string,
  { present, missing }: { present: string[]; missing: string[] },
) {
  const online = createOnlineUpdateCapture(input);
  const databases: CaptureEntry[] = [];
  const warnings: string[] = [];
  const sourceGenerations: Record<string, string | null> = Object.fromEntries(
    missing.map((file) => [file, null]),
  );
  const pending: string[] = input.reuse ? [] : present;
  if (input.reuse) {
    if (!input.postgresOffline && !input.stopped) {
      throw new Error("Reusing PostgreSQL update captures requires exclusive ownership.");
    }
    for (const file of present) {
      if (!(await online.keep(file, { databases, sourceGenerations, warnings }))) {
        pending.push(file);
      }
    }
    await online.finish();
  }
  if (!input.postgresOnline) {
    const space = await checkUpdateDatabaseBackupSpace(
      directory,
      await measureUpdateStateFiles(present),
      input.reuse ? new Set(pending) : undefined,
    );
    warnings.push(...space.warnings);
  }
  return { online, databases, sourceGenerations, warnings, pending };
}

export async function planOnlinePostgresCapture(
  input: OnlineCaptureInput & {
    config: OpenClawConfig;
    stateDir: string;
    postgresSchemaCaptures?: boolean;
  },
  directory: string,
  sourcePath: string,
  warnings: string[],
): Promise<{ server: boolean; onlineExportByteLimit?: number } | undefined> {
  // Client credential rollback reads the shared state family's portable image.
  const server = Boolean(
    input.postgresSchemaCaptures &&
    resolvePathViaExistingAncestorSync(sourcePath) !==
      resolvePathViaExistingAncestorSync(path.join(input.stateDir, "state", "openclaw.sqlite")),
  );
  if (!input.postgresOnline) {
    return { server };
  }
  if (server) {
    warnings.push(
      `Deferred PostgreSQL server capture until the Gateway stops (server free space is unknown): ${sourcePath}`,
    );
    return undefined;
  }
  const { estimatePostgresBackupExport } = await import("../snapshot/database-backup.js");
  const bytes = await estimatePostgresBackupExport(sourcePath, input.config);
  try {
    return { server, onlineExportByteLimit: checkOnlinePostgresExportSpace(directory, bytes) };
  } catch (error) {
    if (!findUpdateCaptureSpaceError(error)) {
      throw error;
    }
    warnings.push(
      `Deferred PostgreSQL capture until the Gateway stops: ${formatErrorMessageWithCode(error)}`,
    );
    return undefined;
  }
}
