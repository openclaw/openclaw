import { isUtf8 } from "node:buffer";
import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import * as tar from "tar";
import { z } from "zod";
import {
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
  resolvePortableArchivePathKey,
  type BackupSymbolicLink,
  buildBackupArchivePath,
} from "../infra/backup-archive-path-policy.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../infra/sqlite-files.js";
import { UpdateRunDriverSchema } from "../infra/update-run-driver-schema.js";
import { BACKUP_MAX_DECOMPRESSION_RATIO } from "./backup-shared.js";

const recoveryPath = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && path.resolve(value) === value);
const recoveryDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const recoveryEntry = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    sourcePath: recoveryPath,
    archivePath: z.string().regex(/^payload\/\d+$/u),
    size: z.number().int().nonnegative(),
    sha256: recoveryDigest,
    sqlite: z.boolean(),
    mode: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("directory"),
    sourcePath: recoveryPath,
    mode: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("symlink"),
    sourcePath: recoveryPath,
    target: z.string().refine((value) => !value.includes("\0")),
    contentPath: recoveryPath.optional(),
  }),
  z.strictObject({
    kind: z.literal("missing"),
    sourcePath: recoveryPath,
    sqlite: z.boolean(),
    directory: z.boolean(),
  }),
]);

const updateRecoveryManifestSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  kind: z.literal("update-recovery"),
  generation: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("baseline") }),
      z.strictObject({ kind: z.literal("candidate"), baselineSha256: recoveryDigest }),
      z.strictObject({
        kind: z.literal("prepared"),
        baselineSha256: recoveryDigest,
        candidateSha256: recoveryDigest,
      }),
    ])
    .optional(),
  databases: z
    .array(
      z.discriminatedUnion("role", [
        z.strictObject({ path: recoveryPath, role: z.literal("global") }),
        z.strictObject({
          path: recoveryPath,
          role: z.literal("agent"),
          agentId: z.string().min(1),
        }),
      ]),
    )
    .optional(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
  installRoot: recoveryPath,
  stateDir: recoveryPath,
  configPath: recoveryPath,
  configPaths: z.array(recoveryPath).min(1).max(512),
  creator: UpdateRunDriverSchema,
  drivers: z.array(UpdateRunDriverSchema).max(32),
  createdAt: z.string().datetime(),
  roots: z.array(recoveryPath).min(1),
  excludedRoots: z.array(recoveryPath),
  protectedPaths: z.array(recoveryPath),
  entries: z.array(recoveryEntry).max(1_000_000),
  warnings: z
    .array(
      z.strictObject({
        kind: z.literal("undeclared-migration-resources"),
        pluginId: z.string().min(1),
        message: z.string().min(1),
      }),
    )
    .optional(),
});

export type UpdateRecoveryBackupManifest = z.infer<typeof updateRecoveryManifestSchema>;

/** Update recovery binds every payload; ordinary archive manifests retain their existing contract. */
export function parseUpdateRecoveryBackupManifest(raw: string): UpdateRecoveryBackupManifest {
  const manifest = updateRecoveryManifestSchema.parse(JSON.parse(raw));
  if (
    (manifest.schemaVersion === 1 && (manifest.generation || manifest.databases)) ||
    (manifest.schemaVersion === 2 && (!manifest.generation || !manifest.databases))
  ) {
    throw new Error("Update recovery generation metadata does not match its format version.");
  }
  const databasePaths = new Set<string>();
  let globalDatabasePath: string | undefined;
  for (const database of manifest.databases ?? []) {
    if (
      databasePaths.has(database.path) ||
      (database.role === "global" && globalDatabasePath !== undefined) ||
      (database.role === "agent" && normalizeAgentId(database.agentId) !== database.agentId)
    ) {
      throw new Error(`Invalid update recovery database identity: ${database.path}`);
    }
    databasePaths.add(database.path);
    if (database.role === "global") {
      globalDatabasePath = database.path;
    }
  }
  const sources = new Map<string, (typeof manifest.entries)[number]>();
  const payloads = new Set<string>();
  const excluded = new Set(manifest.excludedRoots);
  if (
    excluded.size !== manifest.excludedRoots.length ||
    [...manifest.roots, ...manifest.protectedPaths, ...manifest.configPaths].some((pathname) =>
      excluded.has(pathname),
    )
  ) {
    throw new Error("Update recovery exclusions conflict with retained resource inventory.");
  }
  for (const entry of manifest.entries) {
    if (excluded.has(entry.sourcePath)) {
      throw new Error(`Excluded update recovery source has a retained entry: ${entry.sourcePath}`);
    }
    if (entry.kind === "missing" && entry.sqlite && entry.directory) {
      throw new Error("Missing SQLite inventory cannot describe a directory.");
    }
    if (
      sources.has(entry.sourcePath) ||
      !manifest.roots.some((root) => {
        const relative = path.relative(root, entry.sourcePath);
        return (
          relative === "" ||
          (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        );
      })
    ) {
      throw new Error(`Invalid update recovery source: ${entry.sourcePath}`);
    }
    sources.set(entry.sourcePath, entry);
    if (entry.kind === "file") {
      if (payloads.has(entry.archivePath)) {
        throw new Error(`Duplicate update recovery payload: ${entry.archivePath}`);
      }
      payloads.add(entry.archivePath);
    }
  }
  for (const database of manifest.databases ?? []) {
    const entry = sources.get(database.path);
    if (
      !entry ||
      !((entry.kind === "file" || (entry.kind === "missing" && !entry.directory)) && entry.sqlite)
    ) {
      throw new Error(`Update recovery database is missing its SQLite inventory: ${database.path}`);
    }
  }
  if (manifest.roots.some((root) => !sources.has(root))) {
    throw new Error("Update recovery manifest is missing a root entry.");
  }
  if (
    !manifest.configPaths.includes(manifest.configPath) ||
    new Set(manifest.configPaths).size !== manifest.configPaths.length
  ) {
    throw new Error("Update recovery manifest is missing its configuration inventory.");
  }
  // contentPath is the capturing producer's realpath result, which can differ
  // from the lexical target through symlinked ancestors. It must bind captured
  // terminal content, never another symlink that stands in for missing bytes.
  for (const pathname of manifest.configPaths) {
    const config = sources.get(pathname);
    const content =
      config?.kind === "symlink" && config.contentPath
        ? sources.get(config.contentPath)
        : undefined;
    if (
      !config ||
      config.kind === "directory" ||
      (config.kind === "file" && config.sqlite) ||
      (config.kind === "missing" && (config.directory || config.sqlite)) ||
      (config.kind === "symlink" &&
        (!config.contentPath ||
          !manifest.configPaths.includes(config.contentPath) ||
          !content ||
          !(
            (content.kind === "file" || (content.kind === "missing" && !content.directory)) &&
            !content.sqlite
          )))
    ) {
      throw new Error("Update recovery manifest is missing its configuration inventory.");
    }
  }
  return manifest;
}

function backupManifestSizeError(bytes: number): Error | undefined {
  const maxBytes = 1024 * 1024;
  return bytes > maxBytes
    ? new Error(`Backup manifest exceeds ${maxBytes} byte limit.`)
    : undefined;
}

type BackupManifestSqliteSnapshot = { sourcePath: string } & (
  | { role: "global" }
  | { role: "agent"; agentId: string }
);

export type BackupManifest = {
  schemaVersion: number;
  createdAt: string;
  archiveRoot: string;
  runtimeVersion: string;
  platform: string;
  nodeVersion: string;
  options?: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
  };
  paths?: {
    stateDir?: string;
    configPath?: string;
    configSourcePath?: string;
    /** Capture-time canonical identity; payloads retain their archive source spelling. */
    sharedDatabaseSourcePath?: string;
    oauthDir?: string;
    workspaceDirs?: string[];
    agentRoots?: Array<{ agentId: string; sourcePath: string }>;
  };
  assets: Array<{
    kind: string;
    sourcePath: string;
    archivePath: string;
  }>;
  /** Capture-time canonical database inventory; absent in legacy archives. */
  sqliteSnapshots?: BackupManifestSqliteSnapshot[];
  /** Producer-generated capsules, bound to their captured manifests; absent in legacy archives. */
  postgresSnapshots?: Array<{ archivePath: string; manifestSha256: string }>;
  externalSymbolicLinks?: BackupSymbolicLink[];
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

/** Encode the bounded root manifest as the archive's final tar member. */
export function encodeBackupManifest(manifest: BackupManifest): Buffer {
  const contents = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  const sizeError = backupManifestSizeError(contents.length);
  if (sizeError) {
    throw sizeError;
  }
  const header = Buffer.alloc(512);
  new tar.Header({
    path: manifest.archiveRoot + "/manifest.json",
    type: "File",
    mode: 0o644,
    size: contents.length,
  }).encode(header);
  return Buffer.concat([
    header,
    contents,
    Buffer.alloc(((512 - (contents.length % 512)) % 512) + 1024),
  ]);
}

function parseBackupManifestSourcePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Backup manifest ${label} has an invalid sourcePath.`);
  }
  const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\(?![?.]\\))/u.test(value);
  const normalized = windowsPath ? path.win32.normalize(value) : path.posix.normalize(value);
  if ((!windowsPath && !value.startsWith("/")) || normalized !== value) {
    throw new Error(`Backup manifest ${label} sourcePath must be absolute and normalized.`);
  }
  return value;
}

function parseBackupManifestAgentRoots(
  value: unknown,
): Array<{ agentId: string; sourcePath: string }> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest agentRoots must be an array.");
  }

  const agentRoots: Array<{ agentId: string; sourcePath: string }> = [];
  const seenAgentIds = new Set<string>();
  const seenSourcePaths = new Set<string>();
  for (const agentRoot of value) {
    if (
      !isRecord(agentRoot) ||
      Object.keys(agentRoot).length !== 2 ||
      !Object.hasOwn(agentRoot, "agentId") ||
      !Object.hasOwn(agentRoot, "sourcePath")
    ) {
      throw new Error("Backup manifest agent root must contain only agentId and sourcePath.");
    }
    const { agentId, sourcePath } = agentRoot;
    if (typeof agentId !== "string" || !agentId || normalizeAgentId(agentId) !== agentId) {
      throw new Error("Backup manifest agent root has an invalid or noncanonical agentId.");
    }
    const normalizedSourcePath = parseBackupManifestSourcePath(sourcePath, "agent root");
    const windowsPath = /^(?:[A-Za-z]:[\\/]|\\\\(?![?.]\\))/u.test(normalizedSourcePath);
    const sourcePathKey = windowsPath
      ? normalizeWindowsPathForComparison(normalizedSourcePath)
      : normalizedSourcePath;
    if (seenAgentIds.has(agentId) || seenSourcePaths.has(sourcePathKey)) {
      throw new Error("Backup manifest contains duplicate agent root ownership.");
    }
    seenAgentIds.add(agentId);
    seenSourcePaths.add(sourcePathKey);
    agentRoots.push({ agentId, sourcePath: normalizedSourcePath });
  }
  return agentRoots;
}

function parseBackupManifestSqliteSnapshots(
  value: unknown,
): BackupManifestSqliteSnapshot[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest sqliteSnapshots must be an array.");
  }
  let hasGlobal = false;
  const paths = new Set<string>();
  return value.map((snapshot) => {
    if (
      !isRecord(snapshot) ||
      (snapshot.role !== "global" && snapshot.role !== "agent") ||
      Object.keys(snapshot).some(
        (key) =>
          key !== "sourcePath" &&
          key !== "role" &&
          !(snapshot.role === "agent" && key === "agentId"),
      )
    ) {
      throw new Error("Backup manifest contains an invalid SQLite snapshot owner.");
    }
    const sourcePath = parseBackupManifestSourcePath(snapshot.sourcePath, "SQLite snapshot");
    let identity: { role: "global" } | { role: "agent"; agentId: string };
    if (snapshot.role === "global") {
      identity = { role: "global" };
    } else {
      const agentId = snapshot.agentId;
      if (typeof agentId !== "string" || !agentId || normalizeAgentId(agentId) !== agentId) {
        throw new Error("Backup manifest SQLite snapshot has an invalid agentId.");
      }
      identity = { role: "agent", agentId };
    }
    // Archives must restore portably, even when created on a case-sensitive host.
    const sourceKey = sourcePath.replaceAll("\\", "/").normalize("NFC").toLowerCase();
    // A moved agent can retain a distinct database at its previous location.
    if ((identity.role === "global" && hasGlobal) || paths.has(sourceKey)) {
      throw new Error("Backup manifest contains duplicate SQLite snapshot ownership.");
    }
    hasGlobal ||= identity.role === "global";
    paths.add(sourceKey);
    return { sourcePath, ...identity };
  });
}

function parseBackupManifestPostgresSnapshots(value: unknown): BackupManifest["postgresSnapshots"] {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Backup manifest postgresSnapshots must be an array.");
  }
  const paths = new Set<string>();
  return value.map((snapshot) => {
    if (
      !isRecord(snapshot) ||
      Object.keys(snapshot).length !== 2 ||
      typeof snapshot.archivePath !== "string"
    ) {
      throw new Error("Backup manifest contains an invalid PostgreSQL snapshot.");
    }
    const digest = recoveryDigest.safeParse(snapshot.manifestSha256);
    if (!digest.success) {
      throw new Error("Backup manifest contains an invalid PostgreSQL snapshot hash.");
    }
    const archivePath = normalizeArchivePath(snapshot.archivePath, "PostgreSQL capsule path");
    if (archivePath !== snapshot.archivePath || !archivePath.endsWith(".postgres")) {
      throw new Error(
        "Backup manifest PostgreSQL capsule path must be normalized and end in .postgres.",
      );
    }
    const key = archivePath.normalize("NFC").toLowerCase();
    if (paths.has(key)) {
      throw new Error("Backup manifest contains duplicate PostgreSQL snapshot paths.");
    }
    paths.add(key);
    return { archivePath, manifestSha256: digest.data };
  });
}

function readRequiredManifestString(
  record: Record<string, unknown>,
  key: string,
  label = "Backup manifest",
): string {
  const value = readNonBlankString(record[key]);
  if (value === undefined) {
    throw new Error(`${label} is missing ${key}.`);
  }
  return value;
}

export function parseBackupManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("Backup manifest is not valid JSON.", { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Backup manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported backup manifest schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  const archiveRoot = readRequiredManifestString(parsed, "archiveRoot");
  const createdAt = readRequiredManifestString(parsed, "createdAt");
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets = parsed.assets.map((asset) => {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    return {
      kind: readRequiredManifestString(asset, "kind", "Backup manifest asset"),
      sourcePath: readRequiredManifestString(asset, "sourcePath", "Backup manifest asset"),
      archivePath: readRequiredManifestString(asset, "archivePath", "Backup manifest asset"),
    };
  });

  const externalSymbolicLinks: BackupSymbolicLink[] = [];
  if (parsed.externalSymbolicLinks !== undefined) {
    if (!Array.isArray(parsed.externalSymbolicLinks)) {
      throw new Error("Backup manifest externalSymbolicLinks must be an array.");
    }
    for (const link of parsed.externalSymbolicLinks) {
      if (
        !isRecord(link) ||
        typeof link.entryPath !== "string" ||
        typeof link.linkpath !== "string"
      ) {
        throw new Error("Backup manifest contains an invalid external symbolic link.");
      }
      externalSymbolicLinks.push({ entryPath: link.entryPath, linkpath: link.linkpath });
    }
  }

  return {
    schemaVersion: 1,
    archiveRoot,
    createdAt,
    runtimeVersion: readNonBlankString(parsed.runtimeVersion) ?? "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    paths: isRecord(parsed.paths)
      ? {
          ...(parsed.paths.stateDir === undefined
            ? {}
            : {
                stateDir: parseBackupManifestSourcePath(parsed.paths.stateDir, "state directory"),
              }),
          ...(parsed.paths.configPath === undefined
            ? {}
            : {
                configPath: parseBackupManifestSourcePath(parsed.paths.configPath, "configuration"),
              }),
          ...(parsed.paths.configSourcePath === undefined
            ? {}
            : {
                configSourcePath: parseBackupManifestSourcePath(
                  parsed.paths.configSourcePath,
                  "configuration source",
                ),
              }),
          ...(parsed.paths.sharedDatabaseSourcePath === undefined
            ? {}
            : {
                sharedDatabaseSourcePath: parseBackupManifestSourcePath(
                  parsed.paths.sharedDatabaseSourcePath,
                  "shared database source",
                ),
              }),
          agentRoots: parseBackupManifestAgentRoots(parsed.paths.agentRoots),
        }
      : undefined,
    assets,
    sqliteSnapshots: parseBackupManifestSqliteSnapshots(parsed.sqliteSnapshots),
    postgresSnapshots: parseBackupManifestPostgresSnapshots(parsed.postgresSnapshots),
    ...(parsed.externalSymbolicLinks === undefined ? {} : { externalSymbolicLinks }),
  };
}

export function isRootBackupManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

export function verifyBackupManifestEntries(manifest: BackupManifest, entries: Set<string>): void {
  const archiveRoot = normalizeArchiveRoot(manifest.archiveRoot);
  const manifestEntryPath = path.posix.join(archiveRoot, "manifest.json");
  const normalizedEntries = [...entries];

  if (!entries.has(manifestEntryPath)) {
    throw new Error(`Archive is missing manifest entry: ${manifestEntryPath}`);
  }

  for (const entry of normalizedEntries) {
    if (!isArchivePathWithin(entry, archiveRoot)) {
      throw new Error(`Archive entry is outside the declared archive root: ${entry}`);
    }
  }

  const payloadRoot = path.posix.join(archiveRoot, "payload");
  for (const asset of manifest.assets) {
    const assetArchivePath = normalizeArchivePath(asset.archivePath, "Backup manifest asset path");
    if (!isArchivePathWithin(assetArchivePath, payloadRoot)) {
      throw new Error(`Manifest asset path is outside payload root: ${asset.archivePath}`);
    }
    if (
      !entries.has(assetArchivePath) &&
      !normalizedEntries.some((entry) => isArchivePathWithin(entry, assetArchivePath))
    ) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}

/** The capture-time inventory, never today's filesystem, defines required database coverage. */
export function verifyBackupSqliteCoverage(
  manifest: BackupManifest,
  requiredSnapshots: readonly BackupManifestSqliteSnapshot[],
  verifiedSnapshots: readonly ({ archivePath: string } & (
    | { role: "global" }
    | { role: "agent"; agentId: string }
  ))[],
): void {
  for (const required of [...(manifest.sqliteSnapshots ?? []), ...requiredSnapshots]) {
    const expectedPath = buildBackupArchivePath(manifest.archiveRoot, required.sourcePath);
    if (
      !verifiedSnapshots.some(
        (verified) =>
          verified.archivePath === expectedPath &&
          verified.role === required.role &&
          (required.role === "global" ||
            (verified.role === "agent" && verified.agentId === required.agentId)),
      )
    ) {
      throw new Error(`Backup lacks verified SQLite database coverage for ${required.sourcePath}.`);
    }
  }
}

export type NormalizedArchiveEntry = {
  raw: string;
  normalized: string;
  size?: number;
  type?: string;
};

type ArchiveEntry = NormalizedArchiveEntry & {
  linkpath?: string;
};

export async function listBackupArchiveEntries(archivePath: string) {
  const entries: ArchiveEntry[] = [];
  let invalidReason: string | undefined;
  let pathError: Error | undefined;
  let manifestContent: Promise<string | Error> | undefined;
  await tar.t({
    file: archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    onwarn: (code, message) => {
      // tar skips invalid headers; a readable remainder is not a complete backup.
      if (code === "TAR_BAD_ARCHIVE" || code === "TAR_ENTRY_INVALID") {
        invalidReason ??= formatErrorMessage(message);
      }
    },
    onReadEntry: (entry) => {
      if (pathError) {
        return;
      }
      let normalized: string;
      try {
        normalized = normalizeArchivePath(entry.path, "Archive entry");
      } catch (error) {
        pathError ??= toStringifiedError(error);
        return;
      }
      entries.push({
        raw: entry.path,
        normalized,
        ...(entry.linkpath ? { linkpath: entry.linkpath } : {}),
        ...(Number.isSafeInteger(entry.size) && entry.size >= 0 ? { size: entry.size } : {}),
        ...(entry.type ? { type: entry.type } : {}),
      });
      // tar resumes the entry after this callback. Capture only one bounded body;
      // duplicate manifests are rejected after the entire archive has drained.
      if (!manifestContent && isRootBackupManifestEntry(normalized)) {
        manifestContent = readBackupManifestEntry(entry);
      }
    },
  });
  return { entries, invalidReason, pathError, manifestContent };
}

/** Collect during listing; defer content errors until the complete entry inventory is checked. */
async function readBackupManifestEntry(entry: tar.ReadEntry): Promise<string | Error> {
  const sizeError = backupManifestSizeError(entry.size);
  if (sizeError) {
    return sizeError;
  }
  try {
    const content = await entry.concat();
    return isUtf8(content)
      ? content.toString("utf8")
      : new Error("Backup manifest must be valid UTF-8.");
  } catch (error) {
    return toStringifiedError(error);
  }
}

export function isRegularArchiveFile(entryType: string | undefined): boolean {
  return entryType === "File" || entryType === "OldFile" || entryType === "ContiguousFile";
}

export function resolvePostgresRestoreEntries(
  entries: NormalizedArchiveEntry[],
  manifest: BackupManifest,
): {
  captures: Array<{ directoryPath: string; anchorPath: string; manifestSha256?: string }>;
  warnings: string[];
} {
  const captures =
    manifest.postgresSnapshots?.map(({ archivePath, manifestSha256 }) => ({
      directoryPath: archivePath,
      anchorPath: archivePath.slice(0, -".postgres".length),
      manifestSha256,
    })) ??
    (manifest.sqliteSnapshots ?? []).flatMap(({ sourcePath }) => {
      const anchorPath = buildBackupArchivePath(manifest.archiveRoot, sourcePath);
      const directoryPath = `${anchorPath}.postgres`;
      // Legacy ownership comes from the outer core inventory, never a capsule's shape.
      return entries.some((entry) => isArchivePathWithin(entry.normalized, directoryPath))
        ? [{ anchorPath, directoryPath }]
        : [];
    });
  const byPath = new Map(entries.map((entry) => [entry.normalized, entry]));
  const portablePaths = new Set(
    entries.map((entry) => resolvePortableArchivePathKey(entry.normalized)),
  );
  const payloadRoot = path.posix.join(normalizeArchiveRoot(manifest.archiveRoot), "payload");
  for (const { directoryPath, anchorPath } of captures) {
    if (!isArchivePathWithin(directoryPath, payloadRoot)) {
      throw new Error(`PostgreSQL capsule path is outside payload root: ${directoryPath}`);
    }
    for (const database of [
      anchorPath,
      `${directoryPath}/anchor.sqlite`,
      `${directoryPath}/database.sqlite`,
    ]) {
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
        if (portablePaths.has(resolvePortableArchivePathKey(`${database}${suffix}`))) {
          throw new Error(`PostgreSQL export has unexpected SQLite sidecar: ${database}${suffix}`);
        }
      }
    }
    for (const required of [
      anchorPath,
      ...["manifest.json", "anchor.sqlite", "database.sqlite"].map((name) =>
        path.posix.join(directoryPath, name),
      ),
    ]) {
      const entry = byPath.get(required);
      if (!entry || !isRegularArchiveFile(entry.type)) {
        throw new Error(`PostgreSQL backup is missing a regular matched artifact: ${required}`);
      }
    }
  }
  const declaredDirectories = new Set(captures.map(({ directoryPath }) => directoryPath));
  const hasUnlistedLegacyCapsules =
    manifest.postgresSnapshots === undefined &&
    entries.some(
      (entry) =>
        entry.normalized.endsWith(".postgres/manifest.json") &&
        !declaredDirectories.has(path.posix.dirname(entry.normalized)),
    );
  return {
    captures,
    warnings: hasUnlistedLegacyCapsules
      ? [
          "This legacy archive has no PostgreSQL capsule ownership inventory. Unlisted exports are preserved as files, not imported. Re-run backup with this version on the source installation to recover plugin PostgreSQL stores automatically.",
        ]
      : [],
  };
}
