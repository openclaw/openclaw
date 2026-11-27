import path from "node:path";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { SESSION_ARCHIVE_ZSTD_SUFFIX } from "../config/sessions/archive-compression.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { listTranscriptArchives } from "./state-migrations.media-persistence-targets.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import { encodeArchiveContent } from "./state-migrations.transcript-directives-archives.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { decodeUtf8Input } from "./utf8-input.js";
import { resolveZstdCodec } from "./zstd-codec.js";

const ARCHIVE_TEMP_MARKER = ".media-retirement";

function archiveSourceMatches(
  filePath: string,
  expected: ReturnType<typeof readRegularFileSync>,
): boolean {
  try {
    const current = readRegularFileSync({ filePath });
    return (
      current.exactIdentity.dev === expected.exactIdentity.dev &&
      current.exactIdentity.ino === expected.exactIdentity.ino &&
      current.stat.mtimeMs === expected.stat.mtimeMs &&
      current.stat.size === expected.stat.size &&
      current.buffer.equals(expected.buffer)
    );
  } catch {
    return false;
  }
}

function readTranscriptArchiveMigration(filePath: string) {
  const source = readRegularFileSync({ filePath });
  const compressed = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const content = decodeUtf8Input(
    compressed ? resolveZstdCodec().decompress(source.buffer) : source.buffer,
    filePath,
  );
  return { source, compressed, transformed: transformMediaArchiveContent(content, filePath) };
}

/** Read-only: whether `migrateTranscriptArchive` would rewrite this archive file. */
export function transcriptArchiveNeedsMigration(filePath: string): boolean {
  return readTranscriptArchiveMigration(filePath).transformed.changed;
}

function migrateTranscriptArchive(filePath: string): boolean {
  const { source, compressed, transformed } = readTranscriptArchiveMigration(filePath);
  if (!transformed.changed) {
    return false;
  }
  const codec = compressed ? "zstd" : "identity";
  const encoded = encodeArchiveContent(transformed.content, codec, filePath);
  replaceFileAtomicSync({
    allowDrvfsRenameRecovery: true,
    filePath,
    content: encoded,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(filePath)}${ARCHIVE_TEMP_MARKER}`,
    beforeRename: () => {
      if (!archiveSourceMatches(filePath, source)) {
        throw new Error(`${filePath} changed before atomic media migration replacement`);
      }
    },
  });
  return true;
}

/** Rewrite Media* fields in the non-canonical archive files beside each migrated database. */
export async function migrateLegacyTranscriptArchiveFiles(params: {
  env: NodeJS.ProcessEnv;
  directories: Iterable<string>;
  refused: ReadonlySet<string>;
  canonical: ReadonlySet<string>;
  changes: string[];
  warnings: string[];
  signal?: AbortSignal;
}): Promise<{ recoverableWarnings: number; leaseLoss?: MigrationMessages["leaseLoss"] }> {
  const { signal, changes, warnings } = params;
  let recoverableWarnings = 0;
  let leaseLoss: MigrationMessages["leaseLoss"];
  await withAgentDatabaseMaintenanceLease(
    { env: params.env, processBound: true },
    async (maintenance) => {
      for (const directory of params.directories) {
        signal?.throwIfAborted();
        if (params.refused.has(directory)) {
          continue;
        }
        let archives: string[];
        try {
          archives = listTranscriptArchives(directory);
        } catch (error) {
          warnings.push(
            `Could not enumerate transcript archives in ${directory}: ${String(error)}`,
          );
          recoverableWarnings += 1;
          continue;
        }
        for (const archive of archives) {
          signal?.throwIfAborted();
          if (params.canonical.has(path.resolve(archive))) {
            continue;
          }
          try {
            maintenance.renew?.();
            if (migrateTranscriptArchive(archive)) {
              changes.push(`Migrated archived transcript media in ${archive}.`);
            }
          } catch (error) {
            if (signal?.aborted && error === signal.reason) {
              throw error;
            }
            warnings.push(
              `Skipped archived transcript media migration for ${archive}: ${String(error)}`,
            );
            leaseLoss ??= createUpdateErrorFact("media-persistence", error, params.env).leaseLoss;
            recoverableWarnings += 1;
          }
        }
      }
    },
  );
  return { recoverableWarnings, ...(leaseLoss ? { leaseLoss } : {}) };
}
