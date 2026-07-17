// Doctor-only import for retired core JSONL audit stores.
import { createHash, randomUUID } from "node:crypto";
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

type LegacyAuditFileCheckpoint = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

type LegacyAuditRawCheckpoint = LegacyAuditFileCheckpoint & {
  generationKey: string;
  recordCount: number;
  contentHash: string;
};

const LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE = "migration.legacy-audit-raw";
const LEGACY_AUDIT_RAW_CHECKPOINT_MAX_ENTRIES = 10_000;

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

function legacyAuditRawCheckpointKey(checkpoint: LegacyAuditRawCheckpoint): string {
  return checkpoint.generationKey;
}

function legacyAuditSourceGenerationKey(rawArchiveRelativePath: string): string {
  // The numbered raw archive path is the durable generation identity. Unlike
  // device/inode metadata, it survives backup restore and cross-device moves.
  return createHash("sha256")
    .update(rawArchiveRelativePath.replace(/\\/gu, "/"))
    .digest("hex")
    .slice(0, 16);
}

function openLegacyAuditRawCheckpointStore(stateDir: string) {
  return createSqliteAuditRecordStore<LegacyAuditRawCheckpoint>({
    scope: LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE,
    maxEntries: LEGACY_AUDIT_RAW_CHECKPOINT_MAX_ENTRIES,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

function hasLegacyAuditRawCheckpointCapacity(
  stateDir: string,
  rawArchiveRelativePath: string,
): boolean {
  const generationKey = legacyAuditSourceGenerationKey(rawArchiveRelativePath);
  const entries = openLegacyAuditRawCheckpointStore(stateDir).entries();
  return (
    entries.some((entry) => entry.value.generationKey === generationKey) ||
    entries.length < LEGACY_AUDIT_RAW_CHECKPOINT_MAX_ENTRIES
  );
}

function statLegacyAuditRawCheckpoint(sourcePath: string): LegacyAuditFileCheckpoint | undefined {
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return undefined;
    }
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

function legacyAuditRawCheckpointsMatch(
  left: LegacyAuditFileCheckpoint | undefined,
  right: LegacyAuditFileCheckpoint | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function legacyAuditRawCheckpointIsCurrent(
  sourcePath: string,
  checkpoint: LegacyAuditRawCheckpoint,
): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sourcePath, "r");
    const beforeStat = fs.fstatSync(fd);
    const before = {
      dev: beforeStat.dev,
      ino: beforeStat.ino,
      mtimeMs: beforeStat.mtimeMs,
      size: beforeStat.size,
    };
    if (!beforeStat.isFile() || !legacyAuditRawCheckpointsMatch(checkpoint, before)) {
      return false;
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < checkpoint.size) {
      const bytesRead = fs.readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.byteLength, checkpoint.size - offset),
        offset,
      );
      if (bytesRead === 0) {
        return false;
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterStat = fs.fstatSync(fd);
    const after = {
      dev: afterStat.dev,
      ino: afterStat.ino,
      mtimeMs: afterStat.mtimeMs,
      size: afterStat.size,
    };
    return (
      legacyAuditRawCheckpointsMatch(before, after) &&
      offset === checkpoint.size &&
      hash.digest("hex") === checkpoint.contentHash
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
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

export function detectLegacyAuditLogs(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyAuditLogsDetection {
  const candidates: LegacyAuditLogSource[] = [
    {
      kind: "config",
      label: "config audit log",
      sourcePath: path.join(params.stateDir, "logs", "config-audit.jsonl"),
    },
    {
      kind: "system-agent",
      label: "system-agent audit log",
      sourcePath: path.join(params.stateDir, "audit", "system-agent.jsonl"),
    },
    {
      kind: "crestodian",
      label: "Crestodian audit log",
      sourcePath: path.join(params.stateDir, "audit", "crestodian.jsonl"),
    },
  ];
  // Intentionally invisible to automatic startup migration. That caller migrates every
  // detected source; these audit imports belong only to explicit `doctor --fix` repair.
  if (params.doctorOnlyStateMigrations !== true) {
    return { sources: [], hasLegacy: false };
  }
  let checkpoints: LegacyAuditRawCheckpoint[] | undefined;
  const loadCheckpoints = () => {
    if (checkpoints) {
      return checkpoints;
    }
    try {
      checkpoints = openLegacyAuditRawCheckpointStore(params.stateDir)
        .entries()
        .map((entry) => entry.value);
    } catch {
      checkpoints = [];
    }
    return checkpoints;
  };
  const sources: LegacyAuditLogSource[] = [];
  for (const logical of logicalSources) {
    let directoryEntries: string[] = [];
    try {
      directoryEntries = fs.readdirSync(path.dirname(logical.sourcePath));
    } catch {
      // The active-path check below still preserves the ordinary detection result.
    }
    const baseName = path.basename(logical.sourcePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const rawArchivePattern = new RegExp(
      `^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?\\.raw$`,
      "u",
    );
    const claimPattern = new RegExp(
      `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
      "u",
    );
    const rawArchives = directoryEntries
      .flatMap((entry) => {
        const match = rawArchivePattern.exec(entry);
        return match ? [{ entry, generation: BigInt(match[1] ?? "1") }] : [];
      })
      .toSorted(
        (left, right) =>
          (left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0) ||
          left.entry.localeCompare(right.entry),
      );
    for (const { entry } of rawArchives) {
      const rawPath = path.join(path.dirname(logical.sourcePath), entry);
      const rawRelativePath = path.relative(path.resolve(params.stateDir), rawPath);
      const generationKey = legacyAuditSourceGenerationKey(rawRelativePath);
      const checkpoint = statLegacyAuditRawCheckpoint(rawPath);
      if (
        checkpoint &&
        loadCheckpoints().some(
          (candidate) =>
            candidate.generationKey === generationKey &&
            legacyAuditRawCheckpointsMatch(candidate, checkpoint) &&
            legacyAuditRawCheckpointIsCurrent(rawPath, candidate),
        )
      ) {
        continue;
      }
      sources.push({
        ...logical,
        sourcePath: rawPath,
        logicalSourcePath: logical.sourcePath,
        storage: "raw-archive",
        sanitizedArchivePath: rawPath.slice(0, -".raw".length),
      });
    }
    // The claim name reserves its archive generation across a crash. A
    // sanitized-only older generation can therefore never be reused by a later claim.
    const claims = directoryEntries
      .flatMap((entry) => {
        const match = claimPattern.exec(entry);
        return match ? [{ entry, generation: BigInt(match[1] ?? "1") }] : [];
      })
      .toSorted(
        (left, right) =>
          (left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0) ||
          left.entry.localeCompare(right.entry),
      );
    for (const { entry, generation } of claims) {
      const generationSuffix = generation === 1n ? "" : `.${generation}`;
      const sanitizedArchivePath = `${logical.sourcePath}.migrated${generationSuffix}`;
      sources.push({
        ...logical,
        sourcePath: path.join(path.dirname(logical.sourcePath), entry),
        logicalSourcePath: logical.sourcePath,
        storage: "claim",
        sanitizedArchivePath,
        rawArchivePath: `${sanitizedArchivePath}.raw`,
      });
    }
    if (fs.existsSync(logical.sourcePath)) {
      sources.push({
        ...logical,
        logicalSourcePath: logical.sourcePath,
        storage: "active",
      });
    }
  }
  return { sources, hasLegacy: sources.length > 0 };
}

type PreparedLegacyAuditRecords =
  | { ok: false; warnings: string[] }
  | {
      ok: true;
      records: PreparedAuditRecord[];
      sourceRaw: string;
      sanitizedJsonl: string;
    };

function prepareLegacyAuditRecords(
  source: LegacyAuditLogSource,
  raw: string,
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
      key: `legacy:${source.kind}:${index + 1}:${digest}`,
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
    sourceRaw: raw,
    sanitizedJsonl:
      records.length > 0
        ? `${records.map((record) => JSON.stringify(record.value)).join("\n")}\n`
        : "",
  };
}

type AuditMigrationRoot = Awaited<ReturnType<typeof createFsSafeRoot>>;

async function replaceLegacyAuditSourceWithSanitizedContent(params: {
  source: LegacyAuditLogSource;
  sourceRelativePath: string;
  root: AuditMigrationRoot;
  sourceRaw: string;
  sanitizedJsonl: string;
  warnings: string[];
}): Promise<boolean> {
  const tempRelativePath = path.join(
    path.dirname(params.sourceRelativePath),
    `.${path.basename(params.sourceRelativePath)}.sanitize-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await params.root.create(tempRelativePath, params.sanitizedJsonl, {
      mode: 0o600,
    });
    if ((await params.root.readText(params.sourceRelativePath)) !== params.sourceRaw) {
      params.warnings.push(
        `Skipped archiving ${params.source.label} because the legacy source changed during sanitization`,
      );
      return false;
    }
    // The caller holds exclusive Gateway/state ownership, so no legitimate
    // legacy writer can append between this final check and the rooted move.
    // Both paths stay pinned; move commits the prepared bytes atomically.
    await params.root.move(tempRelativePath, params.sourceRelativePath, { overwrite: true });
    return true;
  } catch (error) {
    params.warnings.push(
      `Failed sanitizing ${params.source.label} legacy source before archival: ${String(error)}`,
    );
    return false;
  } finally {
    await params.root.remove(tempRelativePath).catch(() => undefined);
  }
}

async function firstFreeAuditArchiveRelativePath(
  root: AuditMigrationRoot,
  sourceRelativePath: string,
): Promise<string> {
  for (let index = 2; ; index += 1) {
    const candidate = `${sourceRelativePath}.migrated.${index}`;
    if (!(await root.exists(candidate))) {
      return candidate;
    }
  }
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

async function archiveLegacyAuditSource(params: {
  source: LegacyAuditLogSource;
  sourceRelativePath: string;
  root: AuditMigrationRoot;
  changes: string[];
  warnings: string[];
}): Promise<void> {
  const archivedRelativePath = `${params.sourceRelativePath}.migrated`;
  const archivedPath = `${params.source.sourcePath}.migrated`;
  try {
    if (
      !(await secureAuditArchiveFile({
        root: params.root,
        relativePath: params.sourceRelativePath,
        label: params.source.label,
        warnings: params.warnings,
      }))
    ) {
      return;
    }
    if (await params.root.exists(archivedRelativePath)) {
      const nextRelativePath = await firstFreeAuditArchiveRelativePath(
        params.root,
        params.sourceRelativePath,
      );
      await params.root.move(params.sourceRelativePath, nextRelativePath);
      await secureAuditArchiveFile({
        root: params.root,
        relativePath: nextRelativePath,
        label: `archived ${params.source.label}`,
        warnings: params.warnings,
      });
      params.changes.push(
        `Archived ${params.source.label} legacy source → ${path.join(path.dirname(params.source.sourcePath), path.basename(nextRelativePath))}`,
      );
      return;
    }
    await params.root.move(params.sourceRelativePath, archivedRelativePath);
    await secureAuditArchiveFile({
      root: params.root,
      relativePath: archivedRelativePath,
      label: `archived ${params.source.label}`,
      warnings: params.warnings,
    });
    params.changes.push(`Archived ${params.source.label} legacy source → ${archivedPath}`);
  } catch (error) {
    params.warnings.push(
      `Failed archiving ${params.source.label} ${params.source.sourcePath}: ${String(error)}`,
    );
  }
}

async function migrateLegacyAuditLogSource(params: {
  source: LegacyAuditLogSource;
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const root = await createFsSafeRoot(params.stateDir, {
    hardlinks: "reject",
    // Doctor previously accepted the complete legacy log; keep that migration
    // contract while root operations enforce path and symlink boundaries.
    maxBytes: Number.MAX_SAFE_INTEGER,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  const sourceRelativePath = path.relative(path.resolve(params.stateDir), params.source.sourcePath);
  const sourceRaw = await root.readText(sourceRelativePath);
  const prepared = prepareLegacyAuditRecords(params.source, sourceRaw);
  if (!prepared.ok) {
    return { changes, warnings: prepared.warnings };
  }
  const warnings: string[] = [];
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
  const missing = prepared.records.filter((record) => !existingKeys.has(record.key));
  const availableEntries = maxEntries - existingEntries.length;
  if (missing.length > availableEntries) {
    warnings.push(
      `Skipped ${params.source.label} migration because SQLite has room for ${availableEntries} of ${missing.length} missing rows; left legacy source in place`,
    );
    return { changes, warnings };
  }
  store.registerMany(missing);
  const importedKeys = new Set(store.entries().map((entry) => entry.key));
  const missingKey = prepared.records.find((record) => !importedKeys.has(record.key))?.key;
  if (missingKey) {
    warnings.push(`SQLite verification missed ${params.source.label} row ${missingKey}`);
    return { changes, warnings };
  }
  if (
    !(await replaceLegacyAuditSourceWithSanitizedContent({
      source: params.source,
      sourceRelativePath,
      root,
      sourceRaw: prepared.sourceRaw,
      sanitizedJsonl: prepared.sanitizedJsonl,
      warnings,
    }))
  ) {
    return { changes, warnings };
  }
  changes.push(
    `Migrated ${params.source.label} -> shared SQLite state (${missing.length} new row(s))`,
  );
  await archiveLegacyAuditSource({
    source: params.source,
    sourceRelativePath,
    root,
    changes,
    warnings,
  });
  return { changes, warnings };
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
    // Retired audit paths have no current writer. Exclusive state ownership also
    // excludes a running predecessor Gateway and sibling doctor during raw-file removal.
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
    for (const source of params.detected.sources) {
      try {
        const result = await migrateLegacyAuditLogSource({ source, stateDir: params.stateDir });
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
