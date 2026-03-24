import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import type {
  MigrateAssetKind,
  MigrateComponent,
  MigrateManifest,
} from "../commands/migrate-shared.js";
import { resolveConfigPath, resolveOAuthDir, resolveStateDir } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";

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

function parseManifest(raw: string): MigrateManifest {
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
    assets.push({
      kind: asset.kind as MigrateAssetKind,
      sourcePath: typeof asset.sourcePath === "string" ? asset.sourcePath : "",
      archivePath: typeof asset.archivePath === "string" ? asset.archivePath : "",
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
    paths: isRecord(parsed.paths)
      ? {
          stateDir: typeof parsed.paths.stateDir === "string" ? parsed.paths.stateDir : "",
          configPath: typeof parsed.paths.configPath === "string" ? parsed.paths.configPath : "",
          oauthDir: typeof parsed.paths.oauthDir === "string" ? parsed.paths.oauthDir : "",
          workspaceDirs: Array.isArray(parsed.paths.workspaceDirs)
            ? (parsed.paths.workspaceDirs as unknown[]).filter(
                (e): e is string => typeof e === "string",
              )
            : [],
        }
      : { stateDir: "", configPath: "", oauthDir: "", workspaceDirs: [] },
    assets,
    skipped: Array.isArray(parsed.skipped) ? (parsed.skipped as MigrateManifest["skipped"]) : [],
  };
}

function isRootManifestEntry(entryPath: string): boolean {
  const parts = entryPath.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === "manifest.json";
}

async function extractManifestFromArchive(archivePath: string): Promise<MigrateManifest> {
  // First pass: find the manifest entry.
  let manifestEntryPath: string | undefined;
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      if (isRootManifestEntry(entry.path)) {
        manifestEntryPath = entry.path;
      }
    },
  });

  if (!manifestEntryPath) {
    throw new Error("Archive does not contain a migration manifest.");
  }

  // Second pass: extract manifest content.
  const targetEntry = manifestEntryPath;
  let contentPromise: Promise<string> | undefined;
  await tar.t({
    file: archivePath,
    gzip: true,
    onentry: (entry) => {
      if (entry.path !== targetEntry) {
        entry.resume();
        return;
      }
      contentPromise = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    if (relative !== undefined) {
      return path.join(params.localStateDir, relative);
    }
  }

  // Workspace: remap to user-specified dir or infer from state dir.
  if (kind === "workspace") {
    if (params.remapWorkspace) {
      // If there are multiple workspace dirs, create subdirectories.
      if (params.sourceWorkspaceDirs.length > 1) {
        const idx = params.sourceWorkspaceDirs.indexOf(sourcePath);
        if (idx > 0) {
          return path.join(params.remapWorkspace, `workspace-${idx}`);
        }
      }
      return params.remapWorkspace;
    }
    // Default: place workspace under the local state dir.
    if (params.sourceStateDir) {
      const relative = crossPlatformRelative(params.sourceStateDir, sourcePath);
      if (relative !== undefined) {
        return path.join(params.localStateDir, relative);
      }
    }
    return path.join(params.localStateDir, "workspace");
  }

  // Fallback: place under local state dir using relative path from source state dir.
  if (params.sourceStateDir) {
    const relative = crossPlatformRelative(params.sourceStateDir, sourcePath);
    if (relative !== undefined) {
      return path.join(params.localStateDir, relative);
    }
  }

  return path.join(params.localStateDir, path.basename(sourcePath));
}

async function mergeConfigFiles(existingPath: string, importedPath: string): Promise<void> {
  let existingContent: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(existingPath, "utf8");
    existingContent = JSON.parse(raw);
  } catch {
    // If existing config is missing or invalid, overwrite.
  }

  const importedRaw = await fs.readFile(importedPath, "utf8");
  let importedContent: unknown;
  try {
    importedContent = JSON.parse(importedRaw);
  } catch (err) {
    throw new Error(`Imported config file is not valid JSON: ${String(err)}`, { cause: err });
  }

  const merged = applyMergePatch(existingContent, importedContent, {
    mergeObjectArraysById: true,
  });

  await fs.writeFile(existingPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry.name), path.join(dest, entry.name));
    }
  } else {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
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

  // Build import plan: map each manifest asset to a local target path.
  const importAssets: MigrateImportAsset[] = manifest.assets.map((asset) => {
    const targetPath = remapSourceToTarget({
      sourcePath: asset.sourcePath,
      sourceStateDir: manifest.paths.stateDir,
      sourceConfigPath: manifest.paths.configPath,
      sourceOAuthDir: manifest.paths.oauthDir,
      sourceWorkspaceDirs: manifest.paths.workspaceDirs,
      localStateDir,
      localConfigPath,
      localOAuthDir,
      remapWorkspace: opts.remapWorkspace,
      kind: asset.kind,
    });

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

  // Extract to a temporary directory.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-import-"));
  try {
    await tar.x({
      file: archivePath,
      cwd: tempDir,
      gzip: true,
      strip: 0,
      preservePaths: false,
    });

    // Process each asset.
    for (const importAsset of importAssets) {
      const manifestAsset = manifest.assets.find(
        (a) => a.sourcePath === importAsset.sourcePath && a.kind === importAsset.kind,
      );
      if (!manifestAsset) {
        continue;
      }

      const extractedPath = path.join(tempDir, manifestAsset.archivePath);
      const resolvedTempDir = path.resolve(tempDir);
      const resolvedExtracted = path.resolve(extractedPath);
      // Guard against path traversal via crafted manifest archivePath values.
      if (
        resolvedExtracted !== resolvedTempDir &&
        !resolvedExtracted.startsWith(resolvedTempDir + path.sep)
      ) {
        warnings.push(`Skipping asset with unsafe archive path: ${manifestAsset.archivePath}`);
        continue;
      }

      const targetPath = importAsset.targetPath;

      try {
        await fs.access(extractedPath);
      } catch {
        warnings.push(`Asset not found in archive: ${manifestAsset.archivePath}`);
        continue;
      }

      if (importAsset.kind === "config" && merge) {
        // Deep merge config.
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await mergeConfigFiles(targetPath, extractedPath);
      } else {
        // Copy/overwrite.
        await copyRecursive(extractedPath, targetPath);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
