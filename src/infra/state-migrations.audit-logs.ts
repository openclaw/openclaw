// Doctor-only import for retired core JSONL audit stores.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  sanitizeConfigAuditRecord,
  type ConfigAuditRecord,
} from "../config/io.audit.js";
import { redactSecrets } from "../logging/redact.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../system-agent/audit.js";
import { root as createFsSafeRoot } from "./fs-safe.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import {
  hasLegacyAuditRawCheckpointCapacity,
  legacyAuditRawCheckpointKey,
  legacyAuditRawCheckpointsMatch,
  legacyAuditSourceGenerationKey,
  openLegacyAuditRawCheckpointStore,
  type LegacyAuditFileCheckpoint,
  type LegacyAuditRawCheckpoint,
} from "./state-migrations.audit-checkpoints.js";
import type {
  LegacyAuditLogSource,
  LegacyAuditLogsDetection,
} from "./state-migrations.audit-logs.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type PreparedAuditRecord = {
  key: string;
  value: ConfigAuditRecord | SystemAgentAuditEntry;
  createdAt: number;
};

function legacyAuditClaimPathForArchive(sourcePath: string, sanitizedArchivePath: string): string {
  const archivePrefix = `${sourcePath}.migrated`;
  if (!sanitizedArchivePath.startsWith(archivePrefix)) {
    throw new Error(`Invalid legacy audit archive path ${sanitizedArchivePath}`);
  }
  const generationSuffix = sanitizedArchivePath.slice(archivePrefix.length);
  return path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath)}.doctor-importing${generationSuffix}`,
  );
}

function legacyAuditRecordCreatedAt(
  source: LegacyAuditLogSource,
  value: ConfigAuditRecord | SystemAgentAuditEntry,
): number {
  const timestamp =
    source.kind === "config"
      ? (value as Partial<ConfigAuditRecord>).ts
      : (value as Partial<SystemAgentAuditEntry>).timestamp;
  if (typeof timestamp !== "string") {
    return 0;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export { detectLegacyAuditLogs } from "./state-migrations.audit-checkpoints.js";

type PreparedLegacyAuditRecords =
  | { ok: false; warnings: string[] }
  | {
      ok: true;
      records: PreparedAuditRecord[];
      sanitizedJsonl: string;
    };

function prepareLegacyAuditRecords(
  source: LegacyAuditLogSource,
  raw: string,
  sourceGeneration: string,
): PreparedLegacyAuditRecords {
  const records: PreparedAuditRecord[] = [];
  const warnings: string[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      warnings.push(
        `Failed reading ${source.label} record at ${source.sourcePath}:${index + 1}: ${String(error)}`,
      );
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(
        `Skipped non-object ${source.label} record at ${source.sourcePath}:${index + 1}`,
      );
      continue;
    }
    const value =
      source.kind === "config"
        ? sanitizeConfigAuditRecord(parsed as ConfigAuditRecord)
        : (redactSecrets(parsed) as SystemAgentAuditEntry);
    const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
    records.push({
      key: `legacy:${source.kind}:${sourceGeneration}:${index + 1}:${digest}`,
      value,
      createdAt: legacyAuditRecordCreatedAt(source, value),
    });
  }
  if (warnings.length > 0) {
    return { ok: false, warnings };
  }
  return {
    ok: true,
    records,
    sanitizedJsonl:
      records.length > 0
        ? `${records.map((record) => JSON.stringify(record.value)).join("\n")}\n`
        : "",
  };
}

type AuditMigrationRoot = Awaited<ReturnType<typeof createFsSafeRoot>>;

type LegacyAuditSourceSnapshot = LegacyAuditFileCheckpoint & { raw: string };

async function readLegacyAuditSourceSnapshot(
  root: AuditMigrationRoot,
  relativePath: string,
): Promise<LegacyAuditSourceSnapshot> {
  const opened = await root.open(relativePath);
  try {
    const before = await opened.handle.stat();
    if (!before.isFile()) {
      throw new Error("legacy audit source is not a regular file");
    }
    const raw = await opened.handle.readFile({ encoding: "utf8" });
    const after = await opened.handle.stat();
    const beforeCheckpoint = {
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      size: before.size,
    };
    const afterCheckpoint = {
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      size: after.size,
    };
    if (!legacyAuditRawCheckpointsMatch(beforeCheckpoint, afterCheckpoint)) {
      throw new Error("legacy audit source changed while Doctor was reading it");
    }
    return { ...afterCheckpoint, raw };
  } finally {
    await opened.handle.close();
  }
}

async function recordLegacyAuditRawCheckpoint(params: {
  stateDir: string;
  rawPath: string;
  rawRelativePath: string;
  root: AuditMigrationRoot;
  snapshot: LegacyAuditSourceSnapshot;
  recordCount: number;
  warnings: string[];
}): Promise<void> {
  try {
    const opened = await params.root.open(params.rawRelativePath);
    let checkpoint: LegacyAuditRawCheckpoint;
    try {
      const stat = await opened.handle.stat();
      checkpoint = {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        generationKey: legacyAuditSourceGenerationKey(params.rawRelativePath),
        recordCount: params.recordCount,
        contentHash: createHash("sha256").update(params.snapshot.raw).digest("hex"),
      };
    } finally {
      await opened.handle.close();
    }
    if (!legacyAuditRawCheckpointsMatch(checkpoint, params.snapshot)) {
      params.warnings.push(
        `Retained changed legacy audit backup ${params.rawPath}; rerun openclaw doctor --fix to import its later rows`,
      );
      return;
    }
    openLegacyAuditRawCheckpointStore(params.stateDir).upsert(
      legacyAuditRawCheckpointKey(checkpoint),
      checkpoint,
    );
  } catch (error) {
    params.warnings.push(
      `Failed recording legacy audit backup checkpoint for ${params.rawPath}: ${String(error)}`,
    );
  }
}

function findPreviousLegacyAuditRawCheckpoint(
  stateDir: string,
  rawRelativePath: string,
): LegacyAuditRawCheckpoint | undefined {
  const generationKey = legacyAuditSourceGenerationKey(rawRelativePath);
  return openLegacyAuditRawCheckpointStore(stateDir)
    .entries()
    .toReversed()
    .find((entry) => entry.value.generationKey === generationKey)?.value;
}

function recordsAfterLegacyAuditRawCheckpoint(params: {
  checkpoint: LegacyAuditRawCheckpoint;
  snapshot: LegacyAuditSourceSnapshot;
  records: readonly PreparedAuditRecord[];
}): readonly PreparedAuditRecord[] | undefined {
  const rawBytes = Buffer.from(params.snapshot.raw, "utf8");
  if (rawBytes.length < params.checkpoint.size) {
    return undefined;
  }
  const prefixHash = createHash("sha256")
    .update(rawBytes.subarray(0, params.checkpoint.size))
    .digest("hex");
  if (
    prefixHash !== params.checkpoint.contentHash ||
    params.records.length < params.checkpoint.recordCount
  ) {
    return undefined;
  }
  return params.records.slice(params.checkpoint.recordCount);
}

type AuditArchiveRelativePaths = {
  sanitized: string;
  raw: string;
  resumeSanitized: boolean;
};

async function resolveAuditArchiveRelativePaths(
  root: AuditMigrationRoot,
  sourceRelativePath: string,
): Promise<AuditArchiveRelativePaths> {
  const directoryPath = path.join(root.rootReal, path.dirname(sourceRelativePath));
  const baseName = path.basename(sourceRelativePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const archivePattern = new RegExp(
    `^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?(?:\\.raw)?$`,
    "u",
  );
  const claimPattern = new RegExp(
    `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
    "u",
  );
  let latestGeneration = 0n;
  for (const entry of fs.readdirSync(directoryPath)) {
    const match = archivePattern.exec(entry) ?? claimPattern.exec(entry);
    if (!match) {
      continue;
    }
    const generation = BigInt(match[1] ?? "1");
    if (generation > latestGeneration) {
      latestGeneration = generation;
    }
  }
  const generation = latestGeneration + 1n;
  const sanitized = `${sourceRelativePath}.migrated${generation === 1n ? "" : `.${generation}`}`;
  return { sanitized, raw: `${sanitized}.raw`, resumeSanitized: false };
}

async function secureAuditArchiveFile(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  try {
    const opened = await params.root.open(params.relativePath);
    try {
      await opened.handle.chmod(0o600);
      await opened.handle.sync();
    } finally {
      await opened.handle.close();
    }
    return true;
  } catch (error) {
    params.warnings.push(`Failed securing ${params.label} legacy source: ${String(error)}`);
    return false;
  }
}

async function archiveLegacyAuditClaim(params: {
  source: LegacyAuditLogSource;
  claimRelativePath: string;
  archivePaths: { sanitized: string; raw: string; resumeSanitized: boolean };
  sanitizedJsonl: string;
  root: AuditMigrationRoot;
  changes: string[];
  warnings: string[];
}): Promise<{ moved: boolean; rawRelativePath?: string }> {
  let moved = false;
  let sanitizedCreated = false;
  const archivePaths = params.archivePaths;
  try {
    if (archivePaths.resumeSanitized) {
      await params.root.write(archivePaths.sanitized, params.sanitizedJsonl, {
        mkdir: false,
        mode: 0o600,
      });
    } else {
      await params.root.create(archivePaths.sanitized, params.sanitizedJsonl, { mode: 0o600 });
    }
    sanitizedCreated = true;
    if (
      !(await secureAuditArchiveFile({
        root: params.root,
        relativePath: archivePaths.sanitized,
        label: `sanitized ${params.source.label}`,
        warnings: params.warnings,
      }))
    ) {
      return { moved: false };
    }
    // Keep the claimed inode intact. A predecessor CLI may already hold an append
    // descriptor across the claim; moving that inode to a named migration backup
    // preserves any late write while the sanitized sibling remains safe to inspect.
    await params.root.move(params.claimRelativePath, archivePaths.raw);
    if (
      !(await secureAuditArchiveFile({
        root: params.root,
        relativePath: archivePaths.raw,
        label: `raw archived ${params.source.label}`,
        warnings: params.warnings,
      }))
    ) {
      try {
        await params.root.move(archivePaths.raw, params.claimRelativePath);
      } catch (error) {
        params.warnings.push(
          `Failed restoring unsecured ${params.source.label} legacy source: ${String(error)}`,
        );
      }
      return { moved: false };
    }
    moved = true;
    params.changes.push(
      `Archived sanitized ${params.source.label} legacy source → ${path.join(path.dirname(params.source.logicalSourcePath), path.basename(archivePaths.sanitized))}; preserved original inode → ${path.join(path.dirname(params.source.logicalSourcePath), path.basename(archivePaths.raw))}`,
    );
  } catch (error) {
    params.warnings.push(
      `Failed archiving ${params.source.label} ${params.source.logicalSourcePath}: ${String(error)}`,
    );
  } finally {
    if (!moved && sanitizedCreated) {
      await params.root.remove(archivePaths.sanitized).catch(() => undefined);
    }
  }
  return { moved, ...(moved ? { rawRelativePath: archivePaths.raw } : {}) };
}

async function restoreOrPreserveLegacyAuditClaim(params: {
  source: LegacyAuditLogSource;
  claimRelativePath: string;
  sourceRelativePath: string;
  archivePaths: AuditArchiveRelativePaths;
  root: AuditMigrationRoot;
  warnings: string[];
}): Promise<void> {
  try {
    if (!(await params.root.exists(params.claimRelativePath))) {
      return;
    }
    if (!(await params.root.exists(params.sourceRelativePath))) {
      await params.root.move(params.claimRelativePath, params.sourceRelativePath);
      await secureAuditArchiveFile({
        root: params.root,
        relativePath: params.sourceRelativePath,
        label: params.source.label,
        warnings: params.warnings,
      });
      return;
    }
    await params.root.move(params.claimRelativePath, params.archivePaths.raw);
    await secureAuditArchiveFile({
      root: params.root,
      relativePath: params.archivePaths.raw,
      label: `preserved ${params.source.label}`,
      warnings: params.warnings,
    });
    params.warnings.push(
      `Preserved claimed ${params.source.label} at ${path.join(path.dirname(params.source.logicalSourcePath), path.basename(params.archivePaths.raw))} because an old writer recreated ${params.source.logicalSourcePath}`,
    );
  } catch (error) {
    params.warnings.push(
      `Failed restoring claimed ${params.source.label} ${params.source.logicalSourcePath}: ${String(error)}`,
    );
  }
}

async function migrateLegacyAuditLogSource(params: {
  source: LegacyAuditLogSource;
  stateDir: string;
  recreatedSourceScheduled?: boolean;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const root = await createFsSafeRoot(params.stateDir, {
    hardlinks: "reject",
    // Doctor previously accepted the complete legacy log; keep that migration
    // contract while root operations enforce path and symlink boundaries.
    maxBytes: Number.MAX_SAFE_INTEGER,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  const sourceRelativePath = path.relative(
    path.resolve(params.stateDir),
    params.source.logicalSourcePath,
  );
  const detectedRelativePath = path.relative(
    path.resolve(params.stateDir),
    params.source.sourcePath,
  );
  let archivePaths: AuditArchiveRelativePaths | undefined;
  let claimRelativePath = detectedRelativePath;
  if (params.source.storage === "active") {
    archivePaths = await resolveAuditArchiveRelativePaths(root, sourceRelativePath);
    claimRelativePath = path.relative(
      path.resolve(params.stateDir),
      legacyAuditClaimPathForArchive(
        params.source.logicalSourcePath,
        path.join(params.stateDir, archivePaths.sanitized),
      ),
    );
    await root.move(detectedRelativePath, claimRelativePath);
  } else if (params.source.storage === "claim") {
    if (!params.source.sanitizedArchivePath || !params.source.rawArchivePath) {
      throw new Error(`Missing reserved archive generation for ${params.source.sourcePath}`);
    }
    const sanitized = path.relative(
      path.resolve(params.stateDir),
      params.source.sanitizedArchivePath,
    );
    const raw = path.relative(path.resolve(params.stateDir), params.source.rawArchivePath);
    archivePaths = {
      sanitized,
      raw,
      resumeSanitized: (await root.exists(sanitized)) && !(await root.exists(raw)),
    };
  }
  let claimFinalized = params.source.storage === "raw-archive";
  try {
    if (
      !(await secureAuditArchiveFile({
        root,
        relativePath: claimRelativePath,
        label: `claimed ${params.source.label}`,
        warnings,
      }))
    ) {
      return { changes, warnings };
    }
    const rawArchiveRelativePath = archivePaths?.raw ?? detectedRelativePath;
    if (!hasLegacyAuditRawCheckpointCapacity(params.stateDir, rawArchiveRelativePath)) {
      warnings.push(
        `Skipped ${params.source.label} migration because durable raw-archive checkpoint capacity is exhausted; left the legacy source in place`,
      );
      return { changes, warnings };
    }
    const snapshot = await readLegacyAuditSourceSnapshot(root, claimRelativePath);
    const prepared = prepareLegacyAuditRecords(
      params.source,
      snapshot.raw,
      legacyAuditSourceGenerationKey(rawArchiveRelativePath),
    );
    if (!prepared.ok) {
      warnings.push(...prepared.warnings);
      return { changes, warnings };
    }
    const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
    const maxEntries =
      params.source.kind === "config" ? CONFIG_AUDIT_MAX_ENTRIES : SYSTEM_AGENT_AUDIT_MAX_ENTRIES;
    const store = createSqliteAuditRecordStore<ConfigAuditRecord | SystemAgentAuditEntry>({
      scope: params.source.kind === "config" ? CONFIG_AUDIT_SCOPE : SYSTEM_AGENT_AUDIT_SCOPE,
      maxEntries,
      env,
    });
    const existingEntries = store.entries();
    const existingKeys = new Set(existingEntries.map((entry) => entry.key));
    let candidateRecords: readonly PreparedAuditRecord[] = prepared.records;
    if (params.source.storage === "raw-archive") {
      const previousCheckpoint = findPreviousLegacyAuditRawCheckpoint(
        params.stateDir,
        rawArchiveRelativePath,
      );
      if (previousCheckpoint) {
        const appendedRecords = recordsAfterLegacyAuditRawCheckpoint({
          checkpoint: previousCheckpoint,
          snapshot,
          records: prepared.records,
        });
        if (!appendedRecords) {
          warnings.push(
            `Skipped ${params.source.label} recovery because ${params.source.sourcePath} changed other than by append; left the raw archive in place`,
          );
          return { changes, warnings };
        }
        candidateRecords = appendedRecords;
      }
    }
    if (candidateRecords === prepared.records) {
      const lastRetainedSourceIndex = prepared.records.findLastIndex((record) =>
        existingKeys.has(record.key),
      );
      if (lastRetainedSourceIndex >= 0) {
        // A crash can occur after bounded insertion but before its raw checkpoint.
        // Continue after the latest retained source ordinal instead of resurrecting
        // the pruned head as newly appended audit history.
        candidateRecords = prepared.records.slice(lastRetainedSourceIndex + 1);
      }
    }
    const missing = candidateRecords.filter((record) => !existingKeys.has(record.key));
    store.registerLegacyMany(missing);
    const importedKeys = new Set(store.entries().map((entry) => entry.key));
    const retainedNewRows = missing.filter((record) => importedKeys.has(record.key)).length;
    const retentionNote =
      retainedNewRows === missing.length
        ? ""
        : `; ${retainedNewRows} retained after bounded retention`;
    if (params.source.storage === "raw-archive") {
      const sanitizedArchivePath = params.source.sanitizedArchivePath;
      if (!sanitizedArchivePath) {
        throw new Error(`Missing sanitized archive path for ${params.source.sourcePath}`);
      }
      const sanitizedRelativePath = path.relative(
        path.resolve(params.stateDir),
        sanitizedArchivePath,
      );
      await root.write(sanitizedRelativePath, prepared.sanitizedJsonl, {
        mkdir: false,
        mode: 0o600,
      });
      if (
        !(await secureAuditArchiveFile({
          root,
          relativePath: sanitizedRelativePath,
          label: `sanitized ${params.source.label}`,
          warnings,
        }))
      ) {
        return { changes, warnings };
      }
      if (missing.length > 0) {
        changes.push(
          `Recovered ${missing.length} later ${params.source.label} row(s) from ${params.source.sourcePath}${retentionNote}`,
        );
      }
      await recordLegacyAuditRawCheckpoint({
        stateDir: params.stateDir,
        rawPath: params.source.sourcePath,
        rawRelativePath: claimRelativePath,
        root,
        snapshot,
        recordCount: prepared.records.length,
        warnings,
      });
      return { changes, warnings };
    }
    if (!archivePaths) {
      throw new Error(`Missing archive generation for ${params.source.sourcePath}`);
    }
    changes.push(
      `Migrated ${params.source.label} -> shared SQLite state (${missing.length} new row(s)${retentionNote})`,
    );
    const archived = await archiveLegacyAuditClaim({
      source: params.source,
      claimRelativePath,
      archivePaths,
      sanitizedJsonl: prepared.sanitizedJsonl,
      root,
      changes,
      warnings,
    });
    claimFinalized = archived.moved;
    if (!archived.moved || !archived.rawRelativePath) {
      changes.pop();
      return { changes, warnings };
    }
    const rawPath = path.join(params.stateDir, archived.rawRelativePath);
    await recordLegacyAuditRawCheckpoint({
      stateDir: params.stateDir,
      rawPath,
      rawRelativePath: archived.rawRelativePath,
      root,
      snapshot,
      recordCount: prepared.records.length,
      warnings,
    });
    if ((await root.exists(sourceRelativePath)) && !params.recreatedSourceScheduled) {
      warnings.push(
        `An old writer recreated ${params.source.label} at ${params.source.logicalSourcePath}; rerun openclaw doctor --fix to import the retained rows`,
      );
    }
    return { changes, warnings };
  } finally {
    if (!claimFinalized && params.source.storage === "active" && archivePaths) {
      await restoreOrPreserveLegacyAuditClaim({
        source: params.source,
        claimRelativePath,
        sourceRelativePath,
        archivePaths,
        root,
        warnings,
      });
    }
  }
}

export async function migrateLegacyAuditLogs(params: {
  detected: LegacyAuditLogsDetection;
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (params.detected.sources.length === 0) {
    return { changes, warnings };
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    // Exclusive state ownership excludes a predecessor Gateway and sibling doctor.
    // Each source is also atomically claimed because old short-lived CLI processes
    // can append config audit rows without participating in the Gateway lock.
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 25,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
  } catch (error) {
    warnings.push(
      `Skipped legacy audit migration because exclusive state ownership is unavailable: ${String(error)}`,
    );
    return { changes, warnings };
  }
  if (!lock) {
    warnings.push(
      "Skipped legacy audit migration because exclusive state ownership is unavailable",
    );
    return { changes, warnings };
  }
  try {
    for (const [index, source] of params.detected.sources.entries()) {
      try {
        const recreatedSourceScheduled = params.detected.sources
          .slice(index + 1)
          .some(
            (candidate) =>
              candidate.storage === "active" &&
              candidate.logicalSourcePath === source.logicalSourcePath,
          );
        const result = await migrateLegacyAuditLogSource({
          source,
          stateDir: params.stateDir,
          ...(recreatedSourceScheduled ? { recreatedSourceScheduled: true } : {}),
        });
        changes.push(...result.changes);
        warnings.push(...result.warnings);
      } catch (error) {
        warnings.push(`Failed migrating ${source.label}: ${String(error)}`);
      }
    }
  } finally {
    await lock.release();
  }
  return { changes, warnings };
}
