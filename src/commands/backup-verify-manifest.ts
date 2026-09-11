import path from "node:path";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { z } from "zod";
import {
  isArchivePathWithin,
  normalizeArchivePath,
  normalizeArchiveRoot,
} from "../infra/backup-archive-path-policy.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { UpdateRunRecordSchema } from "../infra/update-run-schema.js";
import { isRecord } from "../utils.js";

const recoveryPath = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && path.resolve(value) === value);
const recoveryDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const recoveryEntry = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      sourcePath: recoveryPath,
      archivePath: z.string().regex(/^payload\/\d+$/u),
      size: z.number().int().nonnegative(),
      sha256: recoveryDigest,
      sqlite: z.boolean(),
      mode: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("directory"),
      sourcePath: recoveryPath,
      mode: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("symlink"),
      sourcePath: recoveryPath,
      target: z.string().refine((value) => !value.includes("\0")),
      contentPath: recoveryPath.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("missing"),
      sourcePath: recoveryPath,
      sqlite: z.boolean(),
      directory: z.boolean(),
    })
    .strict(),
]);

const updateRecoveryManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("update-recovery"),
    runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
    installRoot: recoveryPath,
    stateDir: recoveryPath,
    configPath: recoveryPath,
    configPaths: z.array(recoveryPath).min(1).max(512),
    creator: UpdateRunRecordSchema.shape.origin.shape.driver.unwrap(),
    drivers: z.array(UpdateRunRecordSchema.shape.origin.shape.driver.unwrap()).max(32),
    createdAt: z.string().datetime(),
    roots: z.array(recoveryPath).min(1),
    excludedRoots: z.array(recoveryPath),
    protectedPaths: z.array(recoveryPath),
    entries: z.array(recoveryEntry).max(1_000_000),
  })
  .strict();

export type UpdateRecoveryBackupManifest = z.infer<typeof updateRecoveryManifestSchema>;

/** Update recovery binds every payload; ordinary archive manifests retain their existing contract. */
export function parseUpdateRecoveryBackupManifest(raw: string): UpdateRecoveryBackupManifest {
  const manifest = updateRecoveryManifestSchema.parse(JSON.parse(raw));
  const sources = new Set<string>();
  const payloads = new Set<string>();
  for (const entry of manifest.entries) {
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
    sources.add(entry.sourcePath);
    if (entry.kind === "file") {
      if (payloads.has(entry.archivePath)) {
        throw new Error(`Duplicate update recovery payload: ${entry.archivePath}`);
      }
      payloads.add(entry.archivePath);
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
  for (const pathname of manifest.configPaths) {
    const config = manifest.entries.find((entry) => entry.sourcePath === pathname);
    if (
      !config ||
      config.kind === "directory" ||
      (config.kind === "file" && config.sqlite) ||
      (config.kind === "missing" && (config.directory || config.sqlite)) ||
      (config.kind === "symlink" &&
        (!config.contentPath || !manifest.configPaths.includes(config.contentPath)))
    ) {
      throw new Error("Update recovery manifest is missing its configuration inventory.");
    }
  }
  return manifest;
}

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
    oauthDir?: string;
    workspaceDirs?: string[];
    agentRoots?: Array<{ agentId: string; sourcePath: string }>;
  };
  assets: Array<{
    kind: string;
    sourcePath: string;
    archivePath: string;
  }>;
  skipped?: Array<{
    kind?: string;
    sourcePath?: string;
    reason?: string;
    coveredBy?: string;
  }>;
};

function parseBackupManifestSourcePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`Backup manifest ${label} has an invalid sourcePath.`);
  }
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(value);
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
    const windowsPath = /^[A-Za-z]:[\\/]/u.test(normalizedSourcePath);
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
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Backup manifest is missing archiveRoot.");
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Backup manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Backup manifest is missing assets.");
  }

  const assets: BackupManifest["assets"] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Backup manifest contains a non-object asset.");
    }
    if (typeof asset.kind !== "string" || !asset.kind.trim()) {
      throw new Error("Backup manifest asset is missing kind.");
    }
    if (typeof asset.sourcePath !== "string" || !asset.sourcePath.trim()) {
      throw new Error("Backup manifest asset is missing sourcePath.");
    }
    if (typeof asset.archivePath !== "string" || !asset.archivePath.trim()) {
      throw new Error("Backup manifest asset is missing archivePath.");
    }
    assets.push({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
    });
  }

  return {
    schemaVersion: 1,
    archiveRoot: parsed.archiveRoot,
    createdAt: parsed.createdAt,
    runtimeVersion:
      typeof parsed.runtimeVersion === "string" && parsed.runtimeVersion.trim()
        ? parsed.runtimeVersion
        : "unknown",
    platform: typeof parsed.platform === "string" ? parsed.platform : "unknown",
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    paths: isRecord(parsed.paths)
      ? {
          ...(parsed.paths.stateDir === undefined
            ? {}
            : {
                stateDir: parseBackupManifestSourcePath(parsed.paths.stateDir, "state directory"),
              }),
          agentRoots: parseBackupManifestAgentRoots(parsed.paths.agentRoots),
        }
      : undefined,
    assets,
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
  const normalizedEntrySet = new Set(normalizedEntries);

  if (!normalizedEntrySet.has(manifestEntryPath)) {
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
    const exact = normalizedEntrySet.has(assetArchivePath);
    const nested = normalizedEntries.some(
      (entry) => entry !== assetArchivePath && isArchivePathWithin(entry, assetArchivePath),
    );
    if (!exact && !nested) {
      throw new Error(`Archive is missing payload for manifest asset: ${assetArchivePath}`);
    }
  }
}
