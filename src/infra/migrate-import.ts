import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import * as tar from "tar";
import type {
  MigrateAssetKind,
  MigrateComponent,
  MigrateManifest,
} from "../commands/migrate-shared.js";
import { VALID_MIGRATE_ASSET_KINDS } from "../commands/migrate-shared.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";

/** @internal Exported for testing. */
export const MIGRATE_IMPORT_LIMITS = {
  maxEntries: 50_000,
  maxExtractedBytes: 512 * 1024 * 1024, // 512 MB
  maxArchiveBytes: 256 * 1024 * 1024, // 256 MB
} as const;

export type MigrateImportOptions = {
  archive: string;
  merge?: boolean;
  dryRun?: boolean;
  json?: boolean;
  remapWorkspace?: string;
};

export type MigrateImportAsset = {
  kind: MigrateAssetKind;
  sourcePath: string;
  targetPath: string;
  displayTargetPath: string;
  agentId?: string;
};

export type MigrateImportResult = {
  archivePath: string;
  manifest: {
    createdAt: string;
    platform: string;
    runtimeVersion: string;
    components: MigrateComponent[];
    agents: string[];
  };
  dryRun: boolean;
  merge: boolean;
  assets: MigrateImportAsset[];
  warnings: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal Exported for testing. */
export function parseManifest(raw: string): MigrateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Migration manifest is not valid JSON: ${String(err)}`, { cause: err });
  }

  if (!isRecord(parsed)) {
    throw new Error("Migration manifest must be an object.");
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Unsupported migration manifest schemaVersion: ${String(parsed.schemaVersion)}`,
    );
  }
  if (parsed.kind !== "migrate") {
    throw new Error(
      `Archive is not a migration archive (kind: ${typeof parsed.kind === "string" ? parsed.kind : "undefined"}).`,
    );
  }
  if (typeof parsed.archiveRoot !== "string" || !parsed.archiveRoot.trim()) {
    throw new Error("Migration manifest is missing archiveRoot.");
  }
  {
    const normalizedRoot = parsed.archiveRoot.trim();
    if (
      normalizedRoot.includes("/") ||
      normalizedRoot.includes("\\") ||
      normalizedRoot === ".." ||
      normalizedRoot === "."
    ) {
      throw new Error(
        `Migration manifest archiveRoot must be a single path segment: ${normalizedRoot}`,
      );
    }
  }
  if (typeof parsed.createdAt !== "string" || !parsed.createdAt.trim()) {
    throw new Error("Migration manifest is missing createdAt.");
  }
  if (!Array.isArray(parsed.assets)) {
    throw new Error("Migration manifest is missing assets.");
  }

  const assets: MigrateManifest["assets"] = [];
  for (const asset of parsed.assets) {
    if (!isRecord(asset)) {
      throw new Error("Migration manifest contains a non-object asset.");
    }
    const kind = typeof asset.kind === "string" ? asset.kind.trim() : "";
    if (!kind || !VALID_MIGRATE_ASSET_KINDS.includes(kind)) {
      throw new Error(
        `Migration manifest asset has unsupported kind: "${kind}". Valid kinds: ${VALID_MIGRATE_ASSET_KINDS.join(", ")}`,
      );
    }
    const sourcePath = typeof asset.sourcePath === "string" ? asset.sourcePath.trim() : "";
    const archivePath = typeof asset.archivePath === "string" ? asset.archivePath.trim() : "";
    if (!sourcePath || !archivePath) {
      throw new Error("Migration manifest asset is missing sourcePath or archivePath.");
    }
    assets.push({
      kind: kind as MigrateAssetKind,
      sourcePath,
      archivePath,
      agentId: typeof asset.agentId === "string" ? asset.agentId : undefined,
    });
  }

  return {
    schemaVersion: 1,
    kind: "migrate",
    createdAt: String(parsed.createdAt),
    archiveRoot: String(parsed.archiveRoot),
    runtimeVersion: typeof parsed.runtimeVersion === "string" ? parsed.runtimeVersion : "unknown",
    platform: (typeof parsed.platform === "string"
      ? parsed.platform
      : "unknown") as NodeJS.Platform,
    nodeVersion: typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : "unknown",
    components: Array.isArray(parsed.components) ? (parsed.components as MigrateComponent[]) : [],
    agents: Array.isArray(parsed.agents)
      ? (parsed.agents as unknown[]).filter((a): a is string => typeof a === "string")
      : [],
    paths: (() => {
      if (!isRecord(parsed.paths)) {
        throw new Error("Migration manifest is missing paths.");
      }
      const stateDir =
        typeof parsed.paths.stateDir === "string" ? parsed.paths.stateDir.trim() : "";
      const configPath =
        typeof parsed.paths.configPath === "string" ? parsed.paths.configPath.trim() : "";
      const oauthDir =
        typeof parsed.paths.oauthDir === "string" ? parsed.paths.oauthDir.trim() : "";
      if (!stateDir || !configPath || !oauthDir) {
        throw new Error(
          "Migration manifest paths is missing required fields (stateDir, configPath, oauthDir).",
        );
      }
      return {
        stateDir,
        configPath,
        oauthDir,
        workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
          ? (parsed.paths.workspaceDirs as unknown[]).filter(
              (e): e is string => typeof e === "string",
            )
          : [],
      };
    })(),
    assets,
    skipped: Array.isArray(parsed.skipped) ? (parsed.skipped as MigrateManifest["skipped"]) : [],
  };
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

async function extractManifestFromArchive(archivePath: string): Promise<MigrateManifest> {
  const maxScanEntries = MIGRATE_IMPORT_LIMITS.maxEntries;

  // First pass: find the manifest entry (with entry-count guard).
  let manifestEntryPath: string | undefined;
  let pass1Count = 0;
  await tar.t({
    file: archivePath,
    gzip: true,
    filter: () => {
      pass1Count += 1;
      if (pass1Count > maxScanEntries) {
        throw new Error(`Migration archive exceeds entry count limit (${maxScanEntries}).`);
      }
      return true;
    },
    onentry: (entry) => {
      if (isRootManifestEntry(entry.path)) {
        manifestEntryPath = entry.path;
      }
    },
  });

  if (!manifestEntryPath) {
    throw new Error("Archive does not contain a migration manifest.");
  }

  // Second pass: extract manifest content (with entry-count guard).
  const targetEntry = manifestEntryPath;
  let contentPromise: Promise<string> | undefined;
  let pass2Count = 0;
  await tar.t({
    file: archivePath,
    gzip: true,
    filter: () => {
      pass2Count += 1;
      if (pass2Count > maxScanEntries) {
        throw new Error(`Migration archive exceeds entry count limit (${maxScanEntries}).`);
      }
      return true;
    },
    onentry: (entry) => {
      if (entry.path !== targetEntry) {
        entry.resume();
        return;
      }
      contentPromise = new Promise<string>((resolve, reject) => {
        const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MB
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        entry.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.byteLength;
          if (totalBytes > MAX_MANIFEST_BYTES) {
            reject(
              new Error(`Migration manifest exceeds size limit (${MAX_MANIFEST_BYTES} bytes).`),
            );
            entry.destroy();
            return;
          }
          chunks.push(buf);
        });
        entry.on("error", reject);
        entry.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
    },
  });

  if (!contentPromise) {
    throw new Error("Failed to extract migration manifest.");
  }
  return parseManifest(await contentPromise);
}

/**
 * Normalize a foreign path to POSIX style so that `path.posix.relative` works
 * correctly even when the source path comes from a different platform (e.g.
 * Windows `C:\Users\...` imported on Linux/macOS).
 */
export function toPosixPath(p: string): string {
  // Convert Windows drive-letter paths: C:\foo\bar → /C/foo/bar
  const winMatch = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (winMatch) {
    return `/${winMatch[1]}/${winMatch[2].replaceAll("\\", "/")}`;
  }
  return p.replaceAll("\\", "/");
}

/**
 * Compute the relative portion of `child` under `parent`, normalizing both to
 * POSIX first so cross-platform archives produce valid results.
 */
export function crossPlatformRelative(parent: string, child: string): string | undefined {
  const normalizedParent = toPosixPath(parent);
  const normalizedChild = toPosixPath(child);
  if (normalizedParent === normalizedChild) {
    return "";
  }
  const rel = path.posix.relative(normalizedParent, normalizedChild);
  if (!rel || rel.startsWith("..")) {
    return undefined;
  }
  return rel;
}

/**
 * Canonicalize a path by resolving symlinks in the nearest existing ancestor,
 * then appending the remaining non-existent segments. This catches symlinked
 * parent directories that `path.resolve` alone would miss.
 */
/** @internal Exported for testing. */
export async function canonicalizeViaAncestor(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached filesystem root without finding an existing ancestor.
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Sanitize a basename derived from an untrusted source path.
 * Rejects traversal segments and empty values.
 * @internal Exported for testing.
 */
export function safeFallbackName(sourcePath: string, fallback: string): string {
  const raw = path.basename(toPosixPath(sourcePath));
  if (!raw || raw === "." || raw === "..") {
    return fallback;
  }
  return raw;
}

/**
 * Verify that a computed target path stays within the given root directory.
 * Throws if the target escapes the root (e.g. via ".." segments).
 */
function assertTargetWithinRoot(target: string, root: string, label: string): void {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Import target for ${label} escapes root directory: ${target}`);
  }
}

/**
 * Remap the source path from the archive manifest to a target path on the local machine.
 * Handles cross-platform path differences.
 */
function remapSourceToTarget(params: {
  sourcePath: string;
  sourceStateDir: string;
  sourceConfigPath: string;
  sourceOAuthDir: string;
  sourceWorkspaceDirs: string[];
  localStateDir: string;
  localConfigPath: string;
  localOAuthDir: string;
  remapWorkspace?: string;
  kind: MigrateAssetKind;
}): string {
  const { sourcePath, kind } = params;

  // Config goes to local config path.
  if (kind === "config") {
    return params.localConfigPath;
  }

  // Credentials go to local OAuth dir.
  if (kind === "credentials") {
    return params.localOAuthDir;
  }

  // Agent data: remap from source state dir to local state dir.
  if (kind === "agents" && params.sourceStateDir) {
    const relative = crossPlatformRelative(params.sourceStateDir, sourcePath);
    if (relative !== undefined && relative !== "") {
      const target = path.join(params.localStateDir, relative);
      assertTargetWithinRoot(target, params.localStateDir, "agents");
      return target;
    }
  }

  // Workspace: remap to user-specified dir or infer from state dir.
  if (kind === "workspace") {
    if (params.remapWorkspace) {
      // If there are multiple workspace dirs, create subdirectories.
      if (params.sourceWorkspaceDirs.length > 1) {
        const normalizedSource = toPosixPath(sourcePath);
        const idx = params.sourceWorkspaceDirs.findIndex(
          (d) => toPosixPath(d) === normalizedSource,
        );
        if (idx > 0) {
          return path.join(params.remapWorkspace, `workspace-${idx}`);
        }
      }
      return params.remapWorkspace;
    }
    // Default: place workspace under the local state dir.
    if (params.sourceStateDir) {
      const relative = crossPlatformRelative(params.sourceStateDir, sourcePath);
      if (relative !== undefined && relative !== "") {
        const target = path.join(params.localStateDir, relative);
        assertTargetWithinRoot(target, params.localStateDir, "workspace");
        return target;
      }
    }
    // Derive a unique fallback name from the source path basename.
    // Use ".wN" suffix (not "-N") to avoid collisions with basenames
    // that naturally end in "-<number>" (e.g. "workspace-1").
    const basename = safeFallbackName(sourcePath, "workspace");
    const normalizedSource = toPosixPath(sourcePath);
    const idx = params.sourceWorkspaceDirs.findIndex((d) => toPosixPath(d) === normalizedSource);
    const target =
      idx > 0
        ? path.join(params.localStateDir, `${basename}.w${idx}`)
        : path.join(params.localStateDir, basename);
    assertTargetWithinRoot(target, params.localStateDir, "workspace");
    return target;
  }

  // Fallback: place under local state dir using relative path from source state dir.
  if (params.sourceStateDir) {
    const relative = crossPlatformRelative(params.sourceStateDir, sourcePath);
    if (relative !== undefined && relative !== "") {
      const target = path.join(params.localStateDir, relative);
      assertTargetWithinRoot(target, params.localStateDir, kind);
      return target;
    }
  }

  const fallbackTarget = path.join(params.localStateDir, safeFallbackName(sourcePath, "imported"));
  assertTargetWithinRoot(fallbackTarget, params.localStateDir, kind);
  return fallbackTarget;
}

/**
 * Merge pre-parsed imported config content into the existing config file.
 * The imported content must already be validated as a plain object.
 */
async function mergeConfigWithParsed(
  existingPath: string,
  importedContent: unknown,
): Promise<void> {
  let existingContent: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(existingPath, "utf8");
    existingContent = JSON5.parse(raw);
  } catch {
    // If existing config is missing or invalid, overwrite.
  }

  const merged = applyMergePatch(existingContent, importedContent, {
    mergeObjectArraysById: true,
  });

  await fs.writeFile(existingPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  // Use lstat to avoid following symlinks from untrusted archives.
  const stat = await fs.lstat(src);
  if (stat.isSymbolicLink()) {
    // Reject symlinks to prevent traversal outside the extracted tree.
    return;
  }
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else if (stat.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
  // Skip other special file types (sockets, FIFOs, etc.).
}

export function formatMigrateImportSummary(result: MigrateImportResult): string[] {
  const lines = [`Migration archive: ${result.archivePath}`];
  lines.push(
    `Source: ${result.manifest.platform} / OpenClaw ${result.manifest.runtimeVersion} / ${result.manifest.createdAt}`,
  );
  lines.push(`Components: ${result.manifest.components.join(", ")}`);
  if (result.manifest.agents.length > 0) {
    lines.push(`Agents: ${result.manifest.agents.join(", ")}`);
  }
  if (result.merge) {
    lines.push("Mode: merge (deep-merging config into existing)");
  } else {
    lines.push("Mode: overwrite");
  }
  lines.push(`Importing ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    const agentSuffix = asset.agentId ? ` (agent: ${asset.agentId})` : "";
    lines.push(`  ${asset.kind}: ${asset.displayTargetPath}${agentSuffix}`);
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ${warning}`);
    }
  }
  if (result.dryRun) {
    lines.push("Dry run only; no files were written.");
  } else {
    lines.push("Import complete.");
  }
  return lines;
}

export async function importMigrateArchive(
  opts: MigrateImportOptions,
): Promise<MigrateImportResult> {
  const archivePath = resolveUserPath(opts.archive);
  const merge = Boolean(opts.merge);
  const dryRun = Boolean(opts.dryRun);

  // Check archive size before any extraction work (including manifest parsing).
  const archiveStat = await fs.stat(archivePath);
  if (archiveStat.size > MIGRATE_IMPORT_LIMITS.maxArchiveBytes) {
    throw new Error(
      `Migration archive exceeds size limit (${archiveStat.size} bytes > ${MIGRATE_IMPORT_LIMITS.maxArchiveBytes} bytes).`,
    );
  }

  const manifest = await extractManifestFromArchive(archivePath);
  const warnings: string[] = [];

  // Warn on platform mismatch.
  if (manifest.platform !== process.platform) {
    warnings.push(
      `Source platform (${manifest.platform}) differs from this machine (${process.platform}). Paths will be remapped.`,
    );
  }

  const localStateDir = resolveStateDir();
  const localConfigPath = resolveConfigPath();
  const localOAuthDir = resolveOAuthDir();
  const resolvedRemapWorkspace = opts.remapWorkspace
    ? resolveUserPath(opts.remapWorkspace)
    : undefined;

  // Guard against dangerous remap-workspace targets that could cause
  // catastrophic data loss during overwrite (rm + copy).
  // Canonicalize via realpath to dereference symlinks — a symlink to "/"
  // or home would otherwise pass the path.resolve check.
  if (resolvedRemapWorkspace) {
    // Canonicalize by walking up to the nearest existing ancestor and
    // resolving symlinks there, then appending the remaining segments.
    // This catches symlinked parents (e.g. /tmp/link/new-ws where
    // /tmp/link → /) that path.resolve alone would miss.
    const canonicalRemap = await canonicalizeViaAncestor(resolvedRemapWorkspace);
    const root = path.parse(canonicalRemap).root;
    const home = os.homedir();
    if (
      canonicalRemap === root ||
      canonicalRemap === home ||
      canonicalRemap === path.dirname(home)
    ) {
      throw new Error(
        `Refusing --remap-workspace target "${resolvedRemapWorkspace}": path resolves to "${canonicalRemap}" which is too broad and could cause data loss.`,
      );
    }
    // Reject if the target exists and is not a directory.
    try {
      const stat = await fs.lstat(canonicalRemap);
      if (!stat.isDirectory()) {
        throw new Error(
          `--remap-workspace target "${resolvedRemapWorkspace}" exists but is not a directory.`,
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      // ENOENT is fine — directory will be created on import.
    }
  }

  // Build import plan: map each manifest asset to a local target path.
  // Track assigned targets to detect and resolve collisions.
  const assignedTargets = new Set<string>();
  const importAssets: MigrateImportAsset[] = manifest.assets.map((asset) => {
    let targetPath = remapSourceToTarget({
      sourcePath: asset.sourcePath,
      sourceStateDir: manifest.paths.stateDir,
      sourceConfigPath: manifest.paths.configPath,
      sourceOAuthDir: manifest.paths.oauthDir,
      sourceWorkspaceDirs: manifest.paths.workspaceDirs,
      localStateDir,
      localConfigPath,
      localOAuthDir,
      remapWorkspace: resolvedRemapWorkspace,
      kind: asset.kind,
    });

    // Deduplicate: if another asset already claimed this target, append
    // a numeric disambiguator until unique.
    const resolvedTarget = path.resolve(targetPath);
    if (assignedTargets.has(resolvedTarget)) {
      let counter = 1;
      while (assignedTargets.has(path.resolve(`${targetPath}_${counter}`))) {
        counter++;
      }
      targetPath = `${targetPath}_${counter}`;
    }
    assignedTargets.add(path.resolve(targetPath));

    return {
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      targetPath,
      displayTargetPath: shortenHomePath(targetPath),
      agentId: asset.agentId,
    };
  });

  const result: MigrateImportResult = {
    archivePath,
    manifest: {
      createdAt: manifest.createdAt,
      platform: manifest.platform,
      runtimeVersion: manifest.runtimeVersion,
      components: manifest.components,
      agents: manifest.agents,
    },
    dryRun,
    merge,
    assets: importAssets,
    warnings,
  };

  if (dryRun) {
    return result;
  }

  // Extraction safety limits — exported for testing.
  const MAX_EXTRACT_ENTRIES = MIGRATE_IMPORT_LIMITS.maxEntries;
  const MAX_EXTRACT_BYTES = MIGRATE_IMPORT_LIMITS.maxExtractedBytes;

  // Extract to a temporary directory.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-import-"));
  try {
    // Special device types are dangerous — abort extraction.
    // Hard links (Link) are allowed since they reference other entries within
    // the same archive and are safe with preservePaths: false.
    const abortEntryTypes = new Set(["BlockDevice", "CharacterDevice", "FIFO", "Socket"]);
    // Symlinks are skipped (not extracted) but don't abort the whole archive,
    // since self-generated archives may contain workspace symlinks.
    let entryCount = 0;
    let extractedBytes = 0;
    // Use filter for entry counting, type blocking, and symlink skipping.
    // filter runs before extraction — returning false prevents the entry
    // from being written to disk. Throwing from filter aborts the entire
    // tar stream immediately. onReadEntry only fires for entries that
    // pass filter, so we use it only for byte-size tracking.
    const skippedSymlinks: string[] = [];
    await tar.x({
      file: archivePath,
      cwd: tempDir,
      gzip: true,
      strip: 0,
      preservePaths: false,
      filter: (_entryPath, entry) => {
        entryCount += 1;
        if (entryCount > MAX_EXTRACT_ENTRIES) {
          throw new Error(`Migration archive exceeds entry count limit (${MAX_EXTRACT_ENTRIES}).`);
        }
        const entryType = "type" in entry ? (entry as { type: string }).type : "";
        if (abortEntryTypes.has(entryType)) {
          throw new Error(`Blocked unsafe tar entry type "${entryType}": ${_entryPath}`);
        }
        // Skip symlinks — they won't be extracted to disk.
        // Track them so we can warn the user about incomplete restoration.
        if (entryType === "SymbolicLink") {
          skippedSymlinks.push(_entryPath);
          return false;
        }
        return true;
      },
      onReadEntry(entry) {
        const size = typeof entry.size === "number" ? entry.size : 0;
        extractedBytes += size;
        if (extractedBytes > MAX_EXTRACT_BYTES) {
          const error = new Error(
            `Migration archive exceeds extracted size limit (${MAX_EXTRACT_BYTES} bytes).`,
          );
          const emitter = this as unknown as { abort?: (error: Error) => void };
          emitter.abort?.(error);
        }
      },
    });

    if (skippedSymlinks.length > 0) {
      warnings.push(
        `${skippedSymlinks.length} symbolic link(s) were skipped during import and not restored. Affected paths: ${skippedSymlinks.slice(0, 5).join(", ")}${skippedSymlinks.length > 5 ? ` (and ${skippedSymlinks.length - 5} more)` : ""}`,
      );
    }

    const resolvedTempDir = await fs.realpath(tempDir);
    const payloadRoot = path.resolve(path.join(resolvedTempDir, manifest.archiveRoot, "payload"));

    // Pass 1: Validate all declared assets exist and are safe before writing anything.
    // This prevents partial state mutation when a later asset is missing or unsafe.
    // For config assets in merge mode, we also pre-parse the content here so that
    // malformed config payloads fail fast before any writes happen.
    type ValidatedAsset = {
      importAsset: MigrateImportAsset;
      realExtracted: string;
      isDirectory: boolean;
      /** Pre-parsed config content for merge mode (validated during preflight). */
      mergeContent?: unknown;
    };
    const validated: ValidatedAsset[] = [];

    for (let i = 0; i < importAssets.length; i++) {
      const importAsset = importAssets[i];
      const manifestAsset = manifest.assets[i];
      if (!importAsset || !manifestAsset) {
        continue;
      }

      const extractedPath = path.join(resolvedTempDir, manifestAsset.archivePath);

      const resolvedExtracted = path.resolve(extractedPath);
      if (!resolvedExtracted.startsWith(payloadRoot + path.sep)) {
        throw new Error(
          `Import aborted: asset has unsafe archive path: ${manifestAsset.archivePath}`,
        );
      }

      let realExtracted: string;
      try {
        realExtracted = await fs.realpath(extractedPath);
      } catch {
        throw new Error(
          `Import aborted: declared asset not found in archive: ${manifestAsset.archivePath}`,
        );
      }
      if (!realExtracted.startsWith(resolvedTempDir + path.sep)) {
        throw new Error(
          `Import aborted: asset escapes extraction tree: ${manifestAsset.archivePath}`,
        );
      }

      // Validate payload type matches what the write pass expects for each kind.
      const payloadStat = await fs.lstat(realExtracted);
      if (importAsset.kind === "config") {
        if (!payloadStat.isFile()) {
          throw new Error(
            `Import aborted: config asset is not a regular file: ${manifestAsset.archivePath}`,
          );
        }
      } else {
        if (!payloadStat.isDirectory() && !payloadStat.isFile()) {
          throw new Error(
            `Import aborted: ${importAsset.kind} asset is not a file or directory: ${manifestAsset.archivePath}`,
          );
        }
      }

      // For config assets in merge mode, pre-parse and validate the content
      // so malformed payloads fail before any writes happen.
      let mergeContent: unknown;
      if (importAsset.kind === "config" && merge) {
        const raw = await fs.readFile(realExtracted, "utf8");
        try {
          mergeContent = JSON5.parse(raw);
        } catch (err) {
          throw new Error(
            `Import aborted: config payload is not valid JSON/JSON5: ${String(err)}`,
            {
              cause: err,
            },
          );
        }
        if (
          typeof mergeContent !== "object" ||
          mergeContent === null ||
          Array.isArray(mergeContent)
        ) {
          throw new Error("Import aborted: config payload must be a JSON object for merge mode.");
        }
      }

      validated.push({
        importAsset,
        realExtracted,
        isDirectory: payloadStat.isDirectory(),
        mergeContent,
      });
    }

    // Pass 2: All assets validated — now apply writes.
    for (const { importAsset, realExtracted, isDirectory, mergeContent } of validated) {
      const targetPath = importAsset.targetPath;

      if (importAsset.kind === "config" && merge && mergeContent !== undefined) {
        // Config content was pre-parsed and validated in pass 1.
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await mergeConfigWithParsed(targetPath, mergeContent);
      } else {
        if (isDirectory) {
          await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
        }
        await copyRecursive(realExtracted, targetPath);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
