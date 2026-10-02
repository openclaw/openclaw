import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { formatCliCommand } from "../cli/command-format.js";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import {
  isLegacySessionRecordOwnedByTarget,
  readLegacySessionStoreEntries,
  resolveLegacyTranscriptPaths,
  shouldFilterLegacySessionRecordsByTarget,
  type LegacySessionStoreTarget,
} from "../config/sessions/legacy-store-inspection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { sha256Hex } from "./crypto-digest.js";
import { recoverEmptyRetainedTranscript } from "./deferred-plugin-session-empty.js";
import {
  readMigrationArtifactIdentity,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import {
  readLegacyPrimaryTranscriptIdentity,
  readOnlySqliteDbStats,
  readOnlySqliteValidationSnapshot,
} from "./session-sqlite-migration-readers.js";
import { verifyCanonicalSessionTranscriptSources } from "./session-sqlite-transcript-verification.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

export const DEFERRED_SESSION_IMPORT_KIND = "deferred-plugin-session-import";

/** Exact store, logical owner and physical database bind completed-import authority. */
export function resolveDeferredPluginSessionImportSourceKey(target: {
  agentId: string;
  storePath: string;
  sqlitePath: string;
}): string {
  return resolveLegacyMigrationSourceKey(
    DEFERRED_SESSION_IMPORT_KIND,
    target.storePath,
    `${target.agentId}\0${path.resolve(target.sqlitePath)}`,
  );
}

/** A replaced database cannot inherit completed-import authority from an old inode. */
export async function verifyDeferredSessionDatabase(params: {
  cfg: OpenClawConfig;
  target: LegacySessionStoreTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
  sources: Array<{ path: string; originalPath: string }>;
  requireCompleteTranscript?: boolean;
  verifiedSourcePaths?: ReadonlySet<string>;
  onEmptySource?: (sourcePath: string, reason: string) => void;
  assertCurrent: () => void;
}): Promise<void> {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const snapshot = readOnlySqliteValidationSnapshot(target);
  const stats = readOnlySqliteDbStats(target);
  if (!snapshot.ok || !stats.ok || stats.stats.integrityCheck !== "ok") {
    throw new Error(
      `Cannot verify retained session history against ${params.sqlitePath}; inspect SQLite integrity with openclaw doctor --session-sqlite validate. Sources remain protected.`,
    );
  }
  const resolved = new Map(params.sources.map((source) => [source.originalPath, source.path]));
  const verifiedSourcePaths = params.verifiedSourcePaths ?? new Set(resolved.keys());
  const indexPath = resolved.get(path.resolve(target.storePath));
  const issues: Array<{ code: string; message: string }> = [];
  const records = (
    indexPath
      ? readLegacySessionStoreEntries(target, issues, { sourcePath: indexPath }).entries.map(
          ({ entry, sessionKey }) => ({
            entry,
            sessionKey,
            transcriptPath: resolveLegacyTranscriptPaths(
              target,
              entry,
              verifiedSourcePaths,
              params.env,
            ).transcriptPath,
          }),
        )
      : []
  ).filter(
    ({ sessionKey }) =>
      !shouldFilterLegacySessionRecordsByTarget(target) ||
      isLegacySessionRecordOwnedByTarget(params.cfg, target, sessionKey),
  );
  if (issues.some((issue) => issue.code !== "entry_invalid")) {
    throw new Error(
      `Cannot verify retained session index ${target.storePath}: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  for (const record of records) {
    if (
      snapshot.snapshot.sessionKeysBySessionId.get(record.entry.sessionId) !== record.sessionKey
    ) {
      throw new Error(
        `Retained session ${record.sessionKey} is not present in ${params.sqlitePath}; sources remain protected. Preserve ${record.transcriptPath ?? target.storePath} and its backups. Restore the intended session from a verified backup to ${params.sqlitePath}, then run openclaw doctor --session-sqlite recover --session-sqlite-all-agents against the same state directory. Canonical edits and deletions were not replayed.`,
      );
    }
  }
  for (const source of params.sources) {
    if (!isPrimarySessionTranscriptFileName(path.basename(source.originalPath))) {
      continue;
    }
    const sourcePath = resolved.get(source.originalPath);
    const indexed = records.filter((candidate) => candidate.transcriptPath === source.originalPath);
    if (sourcePath && readMigrationArtifactIdentity(sourcePath).size === 0) {
      const reason = await recoverEmptyRetainedTranscript({
        source,
        target,
        env: params.env,
        sessionIds: indexed.map((record) => record.entry.sessionId),
        assertCurrent: params.assertCurrent,
      });
      params.onEmptySource?.(source.path, reason);
      continue;
    }
    if (params.requireCompleteTranscript && indexed.length === 0) {
      throw new Error(`Changed retained transcript has no verified indexed owner: ${source.path}`);
    }
    const sessionIds = indexed.length
      ? indexed.map((record) => record.entry.sessionId)
      : [
          sourcePath &&
            readLegacyPrimaryTranscriptIdentity(sourcePath, source.originalPath)?.sessionId,
        ];
    if (
      !sourcePath ||
      sessionIds.some((sessionId) => {
        if (!sessionId || !snapshot.snapshot.sessionKeysBySessionId.has(sessionId)) {
          return true;
        }
        const verified = verifyCanonicalSessionTranscriptSources({
          target,
          sources: [{ path: sourcePath, originalPath: source.originalPath, sessionId }],
          env: params.env,
        });
        return (
          !verified ||
          (params.requireCompleteTranscript &&
            verified.events !== snapshot.snapshot.transcriptEventCountsBySessionId.get(sessionId))
        );
      })
    ) {
      throw new Error(
        `Retained transcript ${source.path} is not complete in ${params.sqlitePath}; source remains protected. Compare a verified database backup before retrying recovery; canonical history was not overwritten.`,
      );
    }
  }
}

/** Old receipts bind bytes, not row identities; only a proven original JSON value can rebind. */
export function preservesRecordedIndexValue(
  bytes: Buffer,
  identity: MigrationArtifactIdentity,
): boolean {
  const value: unknown = parseJsonWithJson5Fallback(bytes.toString("utf8"));
  const pretty = JSON.stringify(value, null, 2);
  const candidates = [
    bytes.subarray(0, identity.size),
    bytes.subarray(-identity.size),
    ...[JSON.stringify(value), pretty, pretty.replaceAll("\n", "\r\n")].flatMap((encoded) =>
      ["", "\n", "\r\n"].map((ending) => Buffer.from(encoded + ending)),
    ),
  ];
  return candidates.some(
    (original) =>
      original.length === identity.size &&
      sha256Hex(original) === identity.sha256 &&
      isDeepStrictEqual(parseJsonWithJson5Fallback(original.toString("utf8")), value),
  );
}

export function databaseIdentity(sqlitePath: string): string {
  const file = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
  if (!file?.isFile()) {
    throw new Error(
      `The imported session database is missing or no longer a regular file: ${sqlitePath}. Run ${formatCliCommand("openclaw doctor --session-sqlite recover --session-sqlite-all-agents")} against the same state/config before retrying repair.`,
    );
  }
  return `${file.dev}:${file.ino}`;
}

export function sameSourceContent(
  left: MigrationArtifactIdentity,
  right: MigrationArtifactIdentity,
) {
  return left.sha256 === right.sha256 && left.size === right.size;
}

export function readDeferredPluginSessionImportReceipt(params: {
  target: LegacySessionStoreTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
  database?: DatabaseSync;
}) {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const read = (db: DatabaseSync) => {
    const receipt = tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(
          db,
          resolveDeferredPluginSessionImportSourceKey(target),
        )
      : undefined;
    return receipt?.removedSource ? undefined : receipt;
  };
  return params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
}
