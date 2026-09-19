import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  MigrationArtifactSchema,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "../commands/doctor-session-sqlite-artifact.js";
import type { LegacySessionRecord } from "../commands/doctor-session-sqlite-discovery.js";
import {
  canonicalMigrationFilePath,
  filterRestoreManifestTargets,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
} from "../commands/doctor-session-sqlite-migration-run.js";
import {
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
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { DeferredPluginMigration } from "./deferred-plugin-migrations.js";
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
  records: readonly Pick<LegacySessionRecord, "transcriptPath" | "sourceFingerprint">[];
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
  return (
    readDeferredPluginSessionImport({
      cfg: params.cfg,
      target: params.target,
      sqlitePath: params.target.sqlitePath ?? sqlite.path,
      env: params.env,
    }) !== undefined
  );
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
    ? sameMigrationArtifact(readMigrationArtifactIdentity(source.path), source.identity)
      ? source.path
      : undefined
    : (cachedTarget.archives ??= collectArchivedSources(target, env))
        .get(source.path)
        ?.find(
          ({ identity, path: archivePath }) =>
            sameMigrationArtifact(identity, source.identity) &&
            statMigrationPath(archivePath) &&
            sameMigrationArtifact(readMigrationArtifactIdentity(archivePath), source.identity),
        )?.path;
  resolutions.push({ identity: { ...source.identity }, path: resolved });
  cachedTarget.resolved.set(source.path, resolutions);
  return resolved;
}

function assertVerifiedSessionSources(
  params: SessionImportSource,
  receipt: DeferredPluginSessionImport,
  verification: SessionSourceVerification = new Map(),
): void {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const verifiedPaths = new Map<string, string>();
  for (const source of receipt.sources) {
    const verifiedPath = resolveVerifiedSessionSource(source, target, params.env, verification);
    if (!verifiedPath) {
      throw new Error(
        `Retained session migration source changed: ${source.path}. Resolve the source conflict before running openclaw doctor --fix again; the verified import was not replayed.`,
      );
    }
    verifiedPaths.set(source.path, verifiedPath);
  }
  const index = receipt.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  const sourcePath = index && verifiedPaths.get(index.path);
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
    if (transcriptCandidates.some((candidate) => verifiedPaths.has(path.resolve(candidate)))) {
      continue;
    }
    for (const candidate of transcriptCandidates) {
      if (statMigrationPath(candidate)) {
        throw new Error(
          `Retained session migration source changed: ${candidate}. A previously unimported transcript appeared; preserve it and resolve the source conflict before running openclaw doctor --fix again.`,
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
  },
): DeferredPluginSessionImport | undefined {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const read = (db: DatabaseSync) =>
    tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(db, sourceKey(target))
      : undefined;
  const receipt = params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
  if (!receipt) {
    return undefined;
  }
  const recorded = receiptSchema.parse(JSON.parse(receipt.reportJson));
  if (recorded.databaseIdentity !== databaseIdentity(params.sqlitePath)) {
    throw new Error(
      "The verified session import database changed; retained source was not replayed.",
    );
  }
  assertVerifiedSessionSources(params, recorded, params.verification);
  return recorded;
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
