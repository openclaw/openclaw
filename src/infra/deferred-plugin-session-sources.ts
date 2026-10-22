import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatCliCommand } from "../cli/command-format.js";
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
import { resolveRealpathOrAbsolute } from "./boundary-path.js";
import { sha256Hex } from "./crypto-digest.js";
import type { DeferredPluginMigration } from "./deferred-plugin-migrations.js";
import {
  collectArchivedSources,
  existingSessionSourcePaths,
  type ArchivedSessionSources,
} from "./deferred-plugin-session-artifacts.js";
import { databaseIdentity, sameSourceContent } from "./deferred-plugin-session-verification.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";
import {
  resolveSessionSqliteMigrationRunsDir,
  type SessionSqliteMigrationTargetInput as SessionImportTarget,
} from "./session-sqlite-migration-manifest.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  DeferredPluginSessionImportSchema,
  parseSessionImportReceipt,
  type DeferredPluginSessionImport,
} from "./state-migrations.deferred-session-import.js";
import { recordStartupMigrationWarnings } from "./state-migrations.messages.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

export type { DeferredPluginSessionImport } from "./state-migrations.deferred-session-import.js";

export type SessionImportSource = {
  cfg: OpenClawConfig;
  target: LegacySessionStoreTarget;
  sqlitePath: string;
  env: NodeJS.ProcessEnv;
};
/** Transient reuse within one synchronous receipt verification and counting phase. */
export type SessionSourceVerification = Map<
  string,
  {
    archives?: ArchivedSessionSources;
    resolved: Map<string, Array<{ identity: MigrationArtifactIdentity; path: string | undefined }>>;
  }
>;
const RECEIPT_KIND = "deferred-plugin-session-import";

function sourceKey(target: SessionImportTarget): string {
  return resolveLegacyMigrationSourceKey(
    RECEIPT_KIND,
    target.storePath,
    `${target.agentId}\0${path.resolve(target.sqlitePath)}`,
  );
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
  verification: SessionSourceVerification,
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
            sameSourceContent(identity, source.identity) &&
            statMigrationPath(archivePath) &&
            sameSourceContent(readMigrationArtifactIdentity(archivePath), source.identity),
        )?.path;
  resolutions.push({ identity: { ...source.identity }, path: resolved });
  cachedTarget.resolved.set(source.path, resolutions);
  return resolved;
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
        `Retained session migration source changed: ${source.path}. Preserve the current file and its ${source.path}.bak-<pid>-<timestamp> siblings, restore the verified original at ${source.path}, then run openclaw doctor --session-sqlite recover --session-sqlite-all-agents against the same state directory. Canonical SQLite sessions were not replayed.`,
      );
    }
    verifiedPaths.set(source.path, verifiedPath);
  }
  const index = receipt.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  const sourcePath = index && verifiedPaths.get(index.path);
  if (!index && statMigrationPath(params.target.storePath) && onSourceConflict) {
    onSourceConflict(path.resolve(params.target.storePath));
  }
  // Doctor can replace an unavailable legacy index with the receipt's hash-bound source list.
  // A later index is new input and cannot inherit the completed import's authority.
  if (
    (onSourceConflict && (!index || !sourcePath)) ||
    (!index && !statMigrationPath(params.target.storePath))
  ) {
    return;
  }
  if (!index || !sourcePath) {
    throw new Error(
      `Session source changed in ${path.dirname(params.target.storePath)}: the current index has no verified import receipt. Run ${formatCliCommand("openclaw doctor --fix --non-interactive --yes", params.env)} against the same state/config to preserve and reverify it.`,
    );
  }
  const issues: Array<{ code: string; message: string }> = [];
  const source = readLegacySessionStoreEntries(params.target, issues, { sourcePath });
  if (
    issues.some((issue) => issue.code !== "entry_invalid") ||
    !source.bytes ||
    source.bytes.length !== index.identity.size ||
    sha256Hex(source.bytes) !== index.identity.sha256
  ) {
    throw new Error(
      `Retained session migration source changed in ${path.dirname(params.target.storePath)}: ${params.target.storePath}. Run ${formatCliCommand("openclaw doctor --fix --non-interactive --yes", params.env)} against the same state/config to preserve and reverify it.`,
    );
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
    database?: EngineConnection;
    verification?: SessionSourceVerification;
    onSourceConflict?: (sourcePath: string, artifactPath?: string) => void;
    allowMissingIndex?: boolean;
    purpose?: "readiness" | "canonical";
  },
): DeferredPluginSessionImport | undefined {
  const receipt = readDeferredPluginSessionImportReceipt(params);
  if (!receipt) {
    return undefined;
  }
  const binding = parseSessionImportReceipt(params, receipt);
  if (binding.stale) {
    recordStartupMigrationWarnings([
      "Retained session import receipt belongs to a different database; sources remain protected. Run openclaw doctor --fix to recover retained history against the live database.",
    ]);
    return undefined;
  }
  let recorded = { ...binding.recorded, databaseIdentity: binding.currentDatabaseIdentity };
  // Readiness and canonical mutations use the database binding; Doctor verifies source bytes.
  if (params.purpose) {
    return recorded;
  }
  const verification = params.verification ?? new Map();
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
            verification,
          ) ||
          existingSessionSourcePaths(
            source.path,
            { ...params.target, sqlitePath: params.sqlitePath },
            params.env,
          ).length > 0,
      ),
    };
  }
  assertVerifiedSessionSources(params, recorded, verification, params.onSourceConflict);
  return recorded;
}

export function hasDeferredPluginSessionImport(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env">,
): boolean {
  return Boolean(readDeferredPluginSessionImportReceipt(params));
}

/** Cleanup consumes the same receipt and manifest custody as Doctor, including unresolved sources. */
export function readDeferredPluginSessionArtifactPaths(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env">,
): Set<string> {
  const paths = new Set<string>();
  const protect = (file: string) => paths.add(resolveRealpathOrAbsolute(file));
  const receipt = readDeferredPluginSessionImportReceipt(params);
  if (receipt) {
    const recorded = DeferredPluginSessionImportSchema.parse(JSON.parse(receipt.reportJson));
    for (const source of recorded.sources) {
      protect(source.path);
    }
  }
  const archives = collectArchivedSources(
    { ...params.target, sqlitePath: params.sqlitePath },
    params.env,
    true,
  );
  for (const [source, archived] of archives) {
    protect(source);
    for (const artifact of archived) {
      protect(artifact.path);
      for (const dependency of artifact.dependencies) {
        protect(dependency);
      }
    }
  }
  return paths;
}

export function readStaleDeferredPluginSessionImport(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env"> & {
    database?: EngineConnection;
  },
): DeferredPluginSessionImport | undefined {
  const receipt = readDeferredPluginSessionImportReceipt(params);
  const binding = receipt && parseSessionImportReceipt(params, receipt);
  return binding?.stale ? binding.recorded : undefined;
}

export function readDeferredPluginSessionImportReceipt(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env"> & {
    database?: EngineConnection;
  },
) {
  const receipt = readSessionImportReceipt(params);
  return receipt?.removedSource ? undefined : receipt;
}

/** Archive retirement ends active source custody, not the canonical import's no-replay evidence. */
function readSessionImportReceipt(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env"> & {
    database?: EngineConnection;
  },
) {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const read = (db: EngineConnection) =>
    tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(db, sourceKey(target))
      : undefined;
  return params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
}

/** Resolve the verified live or archived legacy index whose canonical import is still bound. */
export function resolveDeferredPluginSessionStoreSource(params: {
  target: LegacySessionStoreTarget;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  const { path: sqlitePath } = resolveSqliteTargetFromSessionStorePath(params.target.storePath, {
    agentId: params.target.agentId,
    env: params.env,
  });
  const receipt = readSessionImportReceipt({ ...params, sqlitePath });
  const binding = receipt && parseSessionImportReceipt({ sqlitePath }, receipt);
  const index =
    binding && !binding.stale
      ? binding.recorded.sources.find(
          (source) => source.path === path.resolve(params.target.storePath),
        )
      : undefined;
  return index
    ? resolveVerifiedSessionSource(index, { ...params.target, sqlitePath }, params.env, new Map())
    : undefined;
}

type PreparedSessionImport =
  | { kind: "absent" }
  | { kind: "stale" }
  | { kind: "canonical"; target: SessionImportTarget };

/** Reuse verified source bytes only within one uninterrupted synchronous migration loop. */
export function prepareDeferredPluginSessionImportReader(
  params: Pick<SessionImportSource, "target" | "env">,
) {
  const verified = new Map<
    string,
    {
      receipt: LegacyMigrationReceipt | null;
      binding: ReturnType<typeof parseSessionImportReceipt> | undefined;
    }
  >();
  return (database: EngineConnection, agentId: string): PreparedSessionImport => {
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
        // Retired source custody still certifies the canonical import's no-replay binding.
        binding: receipt ? parseSessionImportReceipt(target, receipt) : undefined,
      };
      verified.set(key, prepared);
    }
    const binding = prepared.binding;
    if (!binding) {
      return { kind: "absent" };
    }
    if (binding.currentDatabaseIdentity !== databaseIdentity(target.sqlitePath)) {
      throw new Error(
        `The verified session import database changed for ${path.dirname(target.storePath)}; retained source was not replayed. Run ${formatCliCommand("openclaw doctor --session-sqlite recover --session-sqlite-all-agents", params.env)} against the same state/config.`,
      );
    }
    return binding.stale ? { kind: "stale" } : { kind: "canonical", target };
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
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertVerifiedSessionSources(params, report);
      if (report.databaseIdentity !== databaseIdentity(params.sqlitePath)) {
        throw new Error(
          `Session import database changed for ${path.dirname(params.target.storePath)} before its receipt was recorded. Run ${formatCliCommand("openclaw doctor --fix --non-interactive --yes", params.env)} against the same state/config to retry.`,
        );
      }
      const key = sourceKey({
        ...params.target,
        sqlitePath: params.sqlitePath,
      });
      const previous = readLegacyMigrationReceiptFromDatabase(db, key);
      recordLegacyMigrationReceipt(db, {
        sourceKey: key,
        migrationKind: RECEIPT_KIND,
        sourcePath: path.resolve(params.target.storePath),
        targetTable: "session_nodes",
        sourceSha256: index?.identity.sha256 ?? null,
        sourceSizeBytes: index?.identity.size ?? null,
        sourceRecordCount: params.recordCount,
        runId: key,
        reportJson: JSON.stringify(report),
        now: Date.now(),
        upsert: Boolean(
          previous &&
          (previous.removedSource ||
            parseSessionImportReceipt(params, previous).recorded.superseded),
        ),
      });
    },
    { env: params.env },
    { operationLabel: "state.retain-plugin-session-source" },
  );
}
