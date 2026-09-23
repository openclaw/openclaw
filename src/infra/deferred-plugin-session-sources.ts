import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  isPrimarySessionTranscriptFileName,
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import {
  isLegacySessionRecordOwnedByTarget,
  readLegacySessionStoreEntries,
  resolveLegacyTranscriptPaths,
  shouldFilterLegacySessionRecordsByTarget,
  type LegacySessionStoreTarget,
} from "../config/sessions/legacy-store-inspection.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { DeferredPluginMigration } from "./deferred-plugin-migrations.js";
import { verifyDeferredSessionDatabase } from "./deferred-plugin-session-verification.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  MigrationArtifactSchema,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import {
  canonicalMigrationFilePath,
  filterRestoreManifestTargets,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
} from "./session-sqlite-migration-manifest.js";
import type { TranscriptFileFingerprint } from "./session-sqlite-migration-readers.js";
import { recordStartupMigrationWarnings } from "./state-migrations.messages.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

type SessionImportTarget = { agentId: string; storePath: string; sqlitePath: string };
type SessionImportSource = {
  cfg: OpenClawConfig;
  target: LegacySessionStoreTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
};
type ArchivedSessionSources = Map<
  string,
  Array<{ identity: MigrationArtifactIdentity; path: string }>
>;
/** Transient reuse within one synchronous receipt verification and counting phase. */
export type SessionSourceVerification = Map<
  string,
  {
    archives?: ArchivedSessionSources;
    resolved: Map<string, Array<{ identity: MigrationArtifactIdentity; path: string | undefined }>>;
  }
>;
const RECEIPT_KIND = "deferred-plugin-session-import";
const receiptSchema = z.object({
  databaseIdentity: z.string(),
  pluginIds: z.array(z.string()),
  sources: z.array(
    z.object({ path: z.string(), identity: MigrationArtifactSchema.shape.identity }),
  ),
});
export type DeferredPluginSessionImport = z.infer<typeof receiptSchema>;

/** Capture originals before deferral; settlement may only archive these verified identities. */
export function captureDeferredPluginSessionSources(params: {
  storePath: string;
  indexIdentity: MigrationArtifactIdentity;
  records: readonly { transcriptPath?: string; sourceFingerprint?: TranscriptFileFingerprint }[];
  unreferencedJsonlFiles: readonly string[];
  referencedPaths?: ReadonlySet<string>;
}): DeferredPluginSessionImport["sources"] {
  const sources = new Map<string, MigrationArtifactIdentity>([
    [path.resolve(params.storePath), params.indexIdentity],
  ]);
  for (const file of params.unreferencedJsonlFiles) {
    if (!params.referencedPaths?.has(canonicalMigrationFilePath(file))) {
      sources.set(path.resolve(file), readMigrationArtifactIdentity(file));
    }
  }
  for (const record of params.records) {
    if (!record.transcriptPath || !record.sourceFingerprint) {
      continue;
    }
    sources.set(
      path.resolve(record.transcriptPath),
      readMigrationArtifactIdentity(record.transcriptPath, 1n, record.sourceFingerprint),
    );
    for (const file of [
      resolveTrajectoryPath(record.transcriptPath),
      resolveTrajectoryPointerPath(record.transcriptPath),
    ]) {
      if (file && fs.existsSync(file)) {
        sources.set(path.resolve(file), readMigrationArtifactIdentity(file));
      }
    }
  }
  return [...sources].map(([sourcePath, identity]) => ({ path: sourcePath, identity }));
}

export function deferredPluginSessionStoreIds(params: {
  target: { agentId: string; storePath: string };
  pending: readonly DeferredPluginMigration[];
}): string[] {
  if (params.target.storePath.endsWith(".sqlite")) {
    return [];
  }
  // The session owner selected this target. An unavailable plugin cannot yet narrow its inputs.
  return params.pending.map((pending) => pending.pluginId);
}

/** File-era repair must not rewrite an original that a deferred owner still needs. */
export function preserveDeferredPluginSessionSource(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  target: LegacySessionStoreTarget;
  pending: readonly DeferredPluginMigration[];
}): boolean {
  if (deferredPluginSessionStoreIds(params).length > 0) {
    return true;
  }
  const sqlite = resolveSqliteTargetFromSessionStorePath(params.target.storePath, {
    agentId: params.target.agentId,
    env: params.env,
  });
  return hasDeferredPluginSessionImport({
    target: { ...params.target, sqlitePath: params.target.sqlitePath ?? sqlite.path },
    sqlitePath: params.target.sqlitePath ?? sqlite.path,
    env: params.env,
  });
}

function sourceKey(target: SessionImportTarget): string {
  return resolveLegacyMigrationSourceKey(
    RECEIPT_KIND,
    target.storePath,
    `${target.agentId}\0${path.resolve(target.sqlitePath)}`,
  );
}

function databaseIdentity(sqlitePath: string): string {
  const file = fs.lstatSync(sqlitePath, { bigint: true });
  if (!file.isFile()) {
    throw new Error("The imported session database is no longer a regular file.");
  }
  return `${file.dev}:${file.ino}`;
}

function collectArchivedSources(
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
): ArchivedSessionSources {
  const archives: ArchivedSessionSources = new Map();
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    for (const candidate of filterRestoreManifestTargets(manifest, [target])) {
      for (const move of candidate.plannedMoves) {
        if (move.artifact) {
          const paths = archives.get(move.sourcePath) ?? [];
          paths.push({ path: move.archivePath, identity: move.artifact.identity });
          archives.set(move.sourcePath, paths);
        }
      }
    }
  }
  return archives;
}

function existingSessionSourcePaths(
  sourcePath: string,
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
  archives?: ArchivedSessionSources,
): string[] {
  return statMigrationPath(sourcePath)
    ? [sourcePath]
    : ((archives ?? collectArchivedSources(target, env)).get(sourcePath) ?? [])
        .map((source) => source.path)
        .filter((source) => statMigrationPath(source));
}

/** Receipt verification and retained counting share one synchronous phase; publication revalidates. */
export function prepareSessionSourceVerification(params: SessionImportSource) {
  const verification: SessionSourceVerification = new Map();
  return {
    cfg: params.cfg,
    target: params.target,
    resolvedTarget: {
      agentId: params.target.agentId,
      storePath: params.target.storePath,
      sqlitePath: params.sqlitePath,
    },
    sqlitePath: params.sqlitePath,
    env: params.env,
    verification,
  };
}

export function resolveVerifiedSessionSource(
  source: DeferredPluginSessionImport["sources"][number],
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
  verification: SessionSourceVerification = new Map(),
): string | undefined {
  const targetKey = JSON.stringify([sourceKey(target), resolveSessionSqliteMigrationRunsDir(env)]);
  let cachedTarget = verification.get(targetKey);
  if (!cachedTarget) {
    cachedTarget = { resolved: new Map() };
    verification.set(targetKey, cachedTarget);
  }
  const resolutions = cachedTarget.resolved.get(source.path) ?? [];
  const cached = resolutions.find(({ identity }) =>
    sameMigrationArtifact(identity, source.identity),
  );
  if (cached) {
    return cached.path;
  }
  const resolved = statMigrationPath(source.path)
    ? sameSourceContent(readMigrationArtifactIdentity(source.path), source.identity)
      ? source.path
      : undefined
    : (cachedTarget.archives ??= collectArchivedSources(target, env))
        .get(source.path)
        ?.find(
          ({ identity, path: archivePath }) =>
            identity.sha256 === source.identity.sha256 &&
            identity.size === source.identity.size &&
            statMigrationPath(archivePath) &&
            sameSourceContent(readMigrationArtifactIdentity(archivePath), source.identity),
        )?.path;
  resolutions.push({ identity: { ...source.identity }, path: resolved });
  cachedTarget.resolved.set(source.path, resolutions);
  return resolved;
}

function sameSourceContent(left: MigrationArtifactIdentity, right: MigrationArtifactIdentity) {
  return left.sha256 === right.sha256 && left.size === right.size;
}

/** Old receipts bind bytes, not row identities; only a proven original JSON value can rebind. */
function preservesRecordedIndexValue(bytes: Buffer, identity: MigrationArtifactIdentity): boolean {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
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
      createHash("sha256").update(original).digest("hex") === identity.sha256 &&
      isDeepStrictEqual(JSON.parse(original.toString("utf8")), value),
  );
}

function assertVerifiedSessionSources(
  params: SessionImportSource,
  receipt: DeferredPluginSessionImport,
  verification: SessionSourceVerification = new Map(),
  onSourceConflict?: (sourcePath: string, artifactPath?: string) => void,
): void {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const verifiedPaths = new Map<string, string>();
  let conflictArchives: ArchivedSessionSources | undefined;
  for (const source of receipt.sources) {
    let verifiedPath: string | undefined;
    try {
      verifiedPath = resolveVerifiedSessionSource(source, target, params.env, verification);
    } catch (error) {
      if (!onSourceConflict) {
        throw error;
      }
    }
    if (!verifiedPath) {
      if (onSourceConflict) {
        onSourceConflict(source.path);
        for (const artifactPath of existingSessionSourcePaths(
          source.path,
          target,
          params.env,
          (conflictArchives ??= collectArchivedSources(target, params.env)),
        )) {
          if (artifactPath !== source.path) {
            onSourceConflict(source.path, artifactPath);
          }
        }
        continue;
      }
      throw new Error(
        `Retained session migration source changed: ${source.path}. Run openclaw doctor --fix to verify the current input or preserve it in the migration archive; canonical SQLite sessions were not replayed.`,
      );
    }
    verifiedPaths.set(source.path, verifiedPath);
  }
  const index = receipt.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  const sourcePath = index && verifiedPaths.get(index.path);
  // Doctor can replace an unavailable legacy index with the receipt's hash-bound source list.
  // A later index is new input and cannot inherit the completed import's authority.
  if (
    (onSourceConflict && (!index || !sourcePath)) ||
    (!index && !statMigrationPath(params.target.storePath))
  ) {
    return;
  }
  if (!index || !sourcePath) {
    throw new Error("A deferred session import requires its verified original index.");
  }
  const issues: Array<{ code: string; message: string }> = [];
  const source = readLegacySessionStoreEntries(params.target, issues, { sourcePath });
  if (
    issues.some((issue) => issue.code !== "entry_invalid") ||
    !source.bytes ||
    source.bytes.length !== index.identity.size ||
    createHash("sha256").update(source.bytes).digest("hex") !== index.identity.sha256
  ) {
    throw new Error(`Retained session migration source changed: ${params.target.storePath}`);
  }
  for (const { entry, sessionKey } of source.entries) {
    if (
      shouldFilterLegacySessionRecordsByTarget(params.target) &&
      !isLegacySessionRecordOwnedByTarget(params.cfg, params.target, sessionKey)
    ) {
      continue;
    }
    const { transcriptCandidates } = resolveLegacyTranscriptPaths(params.target, entry);
    // Archival must not switch a verified local source to an older foreign fallback.
    if (
      transcriptCandidates.some(
        (candidate) =>
          verifiedPaths.has(path.resolve(candidate)) ||
          (onSourceConflict &&
            receipt.sources.some(
              (recordedSource) => recordedSource.path === path.resolve(candidate),
            )),
      )
    ) {
      continue;
    }
    for (const candidate of transcriptCandidates) {
      if (statMigrationPath(candidate)) {
        if (onSourceConflict) {
          onSourceConflict(candidate);
          continue;
        }
        throw new Error(
          `Retained session migration source changed: ${candidate}. A previously unimported transcript appeared; run openclaw doctor --fix to preserve it in the migration archive.`,
        );
      }
    }
  }
}

/** A completed core import remains authoritative after canonical sessions change or are deleted. */
export function readDeferredPluginSessionImport(
  params: SessionImportSource & {
    database?: DatabaseSync;
    verification?: SessionSourceVerification;
    onSourceConflict?: (sourcePath: string, artifactPath?: string) => void;
    allowMissingIndex?: boolean;
    purpose?: "readiness" | "canonical";
  },
): DeferredPluginSessionImport | undefined {
  const receipt = readSessionImportReceipt(params);
  if (!receipt) {
    return undefined;
  }
  let recorded = parseSessionImportReceipt(params, receipt, params.purpose);
  // Canonical mutations have their own provenance checks; changed plugin inputs cannot undo
  // core import completion or authorize replay of file-era metadata.
  if (params.purpose === "canonical") {
    return recorded;
  }
  if (params.allowMissingIndex && !statMigrationPath(params.target.storePath)) {
    recorded = {
      ...recorded,
      sources: recorded.sources.filter(
        (source) =>
          source.path !== path.resolve(params.target.storePath) ||
          resolveVerifiedSessionSource(
            source,
            { ...params.target, sqlitePath: params.sqlitePath },
            params.env,
            params.verification,
          ) ||
          existingSessionSourcePaths(
            source.path,
            { ...params.target, sqlitePath: params.sqlitePath },
            params.env,
          ).length > 0,
      ),
    };
  }
  try {
    assertVerifiedSessionSources(params, recorded, params.verification, params.onSourceConflict);
  } catch (error) {
    if (params.purpose !== "readiness") {
      throw error;
    }
    recordStartupMigrationWarnings([
      `Retained plugin session source awaits Doctor repair; canonical SQLite sessions remain available: ${String(error)}`,
    ]);
  }
  return recorded;
}

export function hasDeferredPluginSessionImport(params: {
  target: SessionImportTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  return Boolean(readSessionImportReceipt(params));
}

function readSessionImportReceipt(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env"> & { database?: DatabaseSync },
) {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const read = (db: DatabaseSync) =>
    tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(db, sourceKey(target))
      : undefined;
  return params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
}

function parseSessionImportReceipt(
  params: SessionImportSource,
  receipt: LegacyMigrationReceipt,
  purpose?: "readiness" | "canonical",
) {
  const recorded = receiptSchema.parse(JSON.parse(receipt.reportJson));
  if (recorded.databaseIdentity !== databaseIdentity(params.sqlitePath)) {
    if (purpose !== "readiness") {
      throw new Error(
        "The verified session import database changed; run openclaw doctor --session-sqlite recover to verify the retained sources against the current database.",
      );
    }
    recordStartupMigrationWarnings([
      "Retained session import database identity changed; sources remain protected. Run openclaw doctor --session-sqlite recover to revalidate the receipt.",
    ]);
  }
  return recorded;
}

/** Rebuild derived evidence from proven original index values or verified canonical transcripts. */
export function rebuildDeferredPluginSessionSourceIndex(
  params: SessionImportSource & {
    onSourceConflict?: (sourcePath: string, artifactPath?: string, error?: unknown) => void;
  },
): boolean {
  const receipt = readSessionImportReceipt(params);
  if (!receipt) {
    return false;
  }
  const recorded = receiptSchema.parse(JSON.parse(receipt.reportJson));
  const currentDatabaseIdentity = databaseIdentity(params.sqlitePath);
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const index = recorded.sources.find((source) => source.path === path.resolve(target.storePath));
  let verifiedIndex = index;
  const archives = collectArchivedSources(target, params.env);
  const verification: SessionSourceVerification = new Map();
  const verifiedSourcePaths = new Set(recorded.sources.map((source) => source.path));
  const missingIndex =
    index && existingSessionSourcePaths(index.path, target, params.env, archives).length === 0;
  const sources = recorded.sources
    .filter((source) => !missingIndex || source !== index)
    .map((source) => {
      let failure: unknown;
      const candidates = statMigrationPath(source.path)
        ? [source.path]
        : (archives.get(source.path) ?? []).map((archive) => archive.path);
      for (const candidate of candidates) {
        if (!statMigrationPath(candidate)) {
          continue;
        }
        try {
          const identity = readMigrationArtifactIdentity(candidate);
          if (sameSourceContent(identity, source.identity)) {
            return { path: source.path, identity };
          }
          if (
            candidate !== source.path ||
            (source.path !== path.resolve(target.storePath) &&
              !isPrimarySessionTranscriptFileName(path.basename(source.path)))
          ) {
            continue;
          }
          const isIndex = source.path === path.resolve(target.storePath);
          const indexPath =
            !isIndex &&
            verifiedIndex &&
            resolveVerifiedSessionSource(verifiedIndex, target, params.env, verification);
          if (isIndex) {
            const issues: Array<{ code: string; message: string }> = [];
            const current = readLegacySessionStoreEntries(params.target, issues, {
              sourcePath: candidate,
            });
            if (!current.bytes || !preservesRecordedIndexValue(current.bytes, source.identity)) {
              throw new Error(
                `Cannot prove the retained index preserves its original entries, metadata, and transcript links: ${candidate}. ${issues.map((issue) => issue.message).join("; ")}`,
              );
            }
          } else {
            if (!indexPath || !verifiedIndex) {
              throw new Error(
                "Changed transcript has no verified retained index to establish its session owner.",
              );
            }
            verifyDeferredSessionDatabase({
              ...params,
              sources: [
                { originalPath: verifiedIndex.path, path: indexPath },
                { originalPath: source.path, path: candidate },
              ],
              requireCompleteTranscript: true,
              verifiedSourcePaths,
            });
          }
          if (
            !sameMigrationArtifact(readMigrationArtifactIdentity(candidate), identity) ||
            (indexPath &&
              verifiedIndex &&
              !sameSourceContent(readMigrationArtifactIdentity(indexPath), verifiedIndex.identity))
          ) {
            continue;
          }
          if (isIndex) {
            verifiedIndex = { path: source.path, identity };
          }
          return { path: source.path, identity };
        } catch (error) {
          // An unreadable or aliased source remains protected with its recorded identity.
          failure = error;
        }
      }
      if (failure !== undefined) {
        params.onSourceConflict?.(source.path, undefined, failure);
      }
      // Unverified content retains its old receipt until Doctor protects the current artifact.
      return source;
    });
  if (currentDatabaseIdentity !== recorded.databaseIdentity) {
    assertVerifiedSessionSources(params, { ...recorded, sources });
    verifyDeferredSessionDatabase({
      ...params,
      sources: sources.map((source) => ({
        originalPath: source.path,
        path: resolveVerifiedSessionSource(source, target, params.env)!,
      })),
    });
  }
  const rebuilt = { ...recorded, databaseIdentity: currentDatabaseIdentity, sources };
  if (isDeepStrictEqual(rebuilt, recorded)) {
    return false;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const current = readSessionImportReceipt({ ...params, database: db });
      if (
        !isDeepStrictEqual(current, receipt) ||
        databaseIdentity(params.sqlitePath) !== currentDatabaseIdentity
      ) {
        throw new Error("Deferred session import changed before its source index was rebuilt.");
      }
      const reportJson = JSON.stringify(rebuilt);
      const rebuiltIndex = rebuilt.sources.find(
        (source) => source.path === path.resolve(target.storePath),
      );
      const query = getNodeSqliteKysely<DB>(db);
      executeSqliteQuerySync(
        db,
        query
          .updateTable("migration_sources")
          .set({
            report_json: reportJson,
            ...(rebuiltIndex
              ? {
                  source_sha256: rebuiltIndex.identity.sha256,
                  source_size_bytes: rebuiltIndex.identity.size,
                }
              : {}),
          })
          .where("source_key", "=", receipt.sourceKey),
      );
      executeSqliteQuerySync(
        db,
        query
          .updateTable("migration_runs")
          .set({ report_json: reportJson })
          .where("id", "=", receipt.sourceKey),
      );
    },
    { env: params.env },
    { operationLabel: "state.rebuild-plugin-session-source-index" },
  );
  return true;
}

/** Reuse verified source bytes only within one uninterrupted synchronous migration loop. */
export function prepareDeferredPluginSessionImportReader(params: {
  cfg: OpenClawConfig;
  target: LegacySessionStoreTarget;
  env: NodeJS.ProcessEnv;
}) {
  const verified = new Map<
    string,
    { receipt: LegacyMigrationReceipt | null; imported: DeferredPluginSessionImport | undefined }
  >();
  return (database: DatabaseSync, agentId: string): SessionImportTarget | undefined => {
    const sourceTarget = { ...params.target, agentId };
    const sqlite = resolveSqliteTargetFromSessionStorePath(sourceTarget.storePath, {
      agentId,
      env: params.env,
    });
    const target = { ...sourceTarget, sqlitePath: sqlite.path };
    const key = sourceKey(target);
    const receipt = readLegacyMigrationReceiptFromDatabase(database, key);
    let prepared = verified.get(key);
    if (!prepared || !isDeepStrictEqual(prepared.receipt, receipt)) {
      prepared = {
        receipt,
        imported: readDeferredPluginSessionImport({
          cfg: params.cfg,
          target: sourceTarget,
          sqlitePath: sqlite.path,
          env: params.env,
          database,
          purpose: "canonical",
        }),
      };
      verified.set(key, prepared);
    }
    if (!prepared.imported) {
      return undefined;
    }
    if (prepared.imported.databaseIdentity !== databaseIdentity(target.sqlitePath)) {
      throw new Error(
        "The verified session import database changed; retained source was not replayed.",
      );
    }
    return target;
  };
}

/** Called after full core import validation, before any original can be retired. */
export function recordDeferredPluginSessionImport(
  params: SessionImportSource & {
    pluginIds: string[];
    sources: Array<{ path: string; identity: MigrationArtifactIdentity }>;
    recordCount: number;
  },
): void {
  const report: DeferredPluginSessionImport = {
    databaseIdentity: databaseIdentity(params.sqlitePath),
    pluginIds: params.pluginIds,
    sources: params.sources,
  };
  const index = params.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  if (!index) {
    throw new Error("A deferred session import requires its verified original index.");
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertVerifiedSessionSources(params, report);
      if (report.databaseIdentity !== databaseIdentity(params.sqlitePath)) {
        throw new Error("Session import database changed before its receipt was recorded.");
      }
      const key = sourceKey({ ...params.target, sqlitePath: params.sqlitePath });
      recordLegacyMigrationReceipt(db, {
        sourceKey: key,
        migrationKind: RECEIPT_KIND,
        sourcePath: path.resolve(params.target.storePath),
        targetTable: "session_nodes",
        sourceSha256: index.identity.sha256,
        sourceSizeBytes: index.identity.size,
        sourceRecordCount: params.recordCount,
        runId: key,
        reportJson: JSON.stringify(report),
        now: Date.now(),
      });
    },
    { env: params.env },
    { operationLabel: "state.retain-plugin-session-source" },
  );
}
