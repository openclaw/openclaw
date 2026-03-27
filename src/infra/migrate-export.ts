import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import * as tar from "tar";
import { isPathWithin } from "../commands/cleanup-utils.js";
import {
  type MigrateAsset,
  type MigrateComponent,
  type MigrateManifest,
  type SkippedMigrateAsset,
  ALL_MIGRATE_COMPONENTS,
  buildMigrateArchiveBasename,
  buildMigrateArchivePath,
  buildMigrateArchiveRoot,
  resolveMigratePlanFromDisk,
} from "../commands/migrate-shared.js";
import { resolveHomeDir, resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";

export type MigrateExportOptions = {
  output?: string;
  components?: MigrateComponent[];
  agents?: string[];
  stripSecrets?: boolean;
  dryRun?: boolean;
  json?: boolean;
  nowMs?: number;
};

export type MigrateExportResult = {
  createdAt: string;
  archiveRoot: string;
  archivePath: string;
  dryRun: boolean;
  components: MigrateComponent[];
  agents: string[];
  stripSecrets: boolean;
  assets: MigrateAsset[];
  skipped: SkippedMigrateAsset[];
  warnings: string[];
};

async function resolveOutputPath(params: {
  output?: string;
  nowMs: number;
  includedAssets: MigrateAsset[];
  stateDir: string;
}): Promise<string> {
  const basename = buildMigrateArchiveBasename(params.nowMs);
  const rawOutput = params.output?.trim();
  if (!rawOutput) {
    const cwd = path.resolve(process.cwd());
    const canonicalCwd = await fs.realpath(cwd).catch(() => cwd);
    const cwdInsideSource = params.includedAssets.some((asset) =>
      isPathWithin(canonicalCwd, asset.sourcePath),
    );
    const defaultDir = cwdInsideSource ? (resolveHomeDir() ?? path.dirname(params.stateDir)) : cwd;
    return path.resolve(defaultDir, basename);
  }

  const resolved = resolveUserPath(rawOutput);
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return path.join(resolved, basename);
    }
  } catch {
    // Treat as a file path when the target does not exist yet.
  }

  return resolved;
}

function isLinkUnsupportedError(code: string | undefined): boolean {
  return code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM" || code === "EXDEV";
}

async function publishTempArchive(params: {
  tempArchivePath: string;
  outputPath: string;
}): Promise<void> {
  try {
    await fs.link(params.tempArchivePath, params.outputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing archive: ${params.outputPath}`, {
        cause: err,
      });
    }
    if (!isLinkUnsupportedError(code)) {
      throw err;
    }

    try {
      await fs.copyFile(params.tempArchivePath, params.outputPath, fsConstants.COPYFILE_EXCL);
    } catch (copyErr) {
      const copyCode = (copyErr as NodeJS.ErrnoException | undefined)?.code;
      if (copyCode !== "EEXIST") {
        await fs.rm(params.outputPath, { force: true }).catch(() => undefined);
      }
      if (copyCode === "EEXIST") {
        throw new Error(`Refusing to overwrite existing archive: ${params.outputPath}`, {
          cause: copyErr,
        });
      }
      throw copyErr;
    }
  }
  await fs.rm(params.tempArchivePath, { force: true });
}

async function canonicalizePathForContainment(targetPath: string): Promise<string> {
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
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Strip known secret keys from a config object.
 * Returns a shallow-ish copy with sensitive values replaced by placeholder strings.
 */
function redactConfigSecrets(configContent: string): string {
  try {
    // Use JSON5 to handle OpenClaw's JSON5-compatible config files
    // (comments, trailing commas). Output as standard JSON.
    const parsed = JSON5.parse(configContent);
    redactObjectSecrets(parsed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    throw new Error(
      "Failed to parse config for secret redaction. The config file may be malformed.",
    );
  }
}

const SECRET_KEY_PATTERNS = [
  /token$/i,
  /secret$/i,
  /password$/i,
  /apikey$/i,
  /api_key$/i,
  /^auth$/i,
  /credentials?$/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function redactArraySecrets(arr: unknown[]): void {
  for (const element of arr) {
    if (Array.isArray(element)) {
      redactArraySecrets(element);
    } else if (typeof element === "object" && element !== null) {
      redactObjectSecrets(element as Record<string, unknown>);
    }
  }
}

function redactObjectSecrets(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && isSecretKey(key)) {
      obj[key] = "<REDACTED>";
    } else if (Array.isArray(value)) {
      redactArraySecrets(value);
    } else if (typeof value === "object" && value !== null) {
      redactObjectSecrets(value as Record<string, unknown>);
    }
  }
}

/** @internal Exported for testing. */
export { redactConfigSecrets };

function buildManifest(params: {
  createdAt: string;
  archiveRoot: string;
  components: MigrateComponent[];
  agents: string[];
  assets: MigrateAsset[];
  skipped: SkippedMigrateAsset[];
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
}): MigrateManifest {
  return {
    schemaVersion: 1,
    kind: "migrate",
    createdAt: params.createdAt,
    archiveRoot: params.archiveRoot,
    runtimeVersion: resolveRuntimeServiceVersion(),
    platform: process.platform,
    nodeVersion: process.version,
    components: params.components,
    agents: params.agents,
    paths: {
      stateDir: params.stateDir,
      configPath: params.configPath,
      oauthDir: params.oauthDir,
      workspaceDirs: params.workspaceDirs,
    },
    assets: params.assets.map((asset) => ({
      kind: asset.kind,
      sourcePath: asset.sourcePath,
      archivePath: asset.archivePath,
      agentId: asset.agentId,
    })),
    skipped: params.skipped.map((entry) => ({
      kind: entry.kind,
      sourcePath: entry.sourcePath,
      reason: entry.reason,
    })),
  };
}

function remapArchiveEntryPath(params: {
  entryPath: string;
  manifestPath: string;
  archiveRoot: string;
}): string {
  // Normalize both to resolved paths for comparison. Use path.resolve on both
  // sides so the comparison is consistent even when tar normalizes separators.
  const normalizedEntry = path.resolve(params.entryPath);
  const normalizedManifest = path.resolve(params.manifestPath);
  if (normalizedEntry === normalizedManifest) {
    return path.posix.join(params.archiveRoot, "manifest.json");
  }
  return buildMigrateArchivePath(params.archiveRoot, normalizedEntry);
}

export function formatMigrateExportSummary(result: MigrateExportResult): string[] {
  const lines = [`Migration archive: ${result.archivePath}`];
  lines.push(`Components: ${result.components.join(", ")}`);
  if (result.agents.length > 0) {
    lines.push(`Agents: ${result.agents.join(", ")}`);
  }
  if (result.stripSecrets) {
    lines.push("Secrets: stripped");
  }
  lines.push(`Included ${result.assets.length} path${result.assets.length === 1 ? "" : "s"}:`);
  for (const asset of result.assets) {
    const agentSuffix = asset.agentId ? ` (agent: ${asset.agentId})` : "";
    lines.push(`  ${asset.kind}: ${asset.displayPath}${agentSuffix}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} path${result.skipped.length === 1 ? "" : "s"}:`);
    for (const entry of result.skipped) {
      lines.push(`  ${entry.kind}: ${entry.displayPath} (${entry.reason})`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`  ${warning}`);
    }
  }
  if (result.dryRun) {
    lines.push("Dry run only; archive was not written.");
  } else {
    lines.push(`Created ${result.archivePath}`);
  }
  return lines;
}

export async function createMigrateArchive(
  opts: MigrateExportOptions = {},
): Promise<MigrateExportResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const archiveRoot = buildMigrateArchiveRoot(nowMs);
  const components = opts.components ?? [...ALL_MIGRATE_COMPONENTS];
  const stripSecrets = Boolean(opts.stripSecrets);
  const plan = await resolveMigratePlanFromDisk({
    components,
    agents: opts.agents,
    nowMs,
  });

  const outputPath = await resolveOutputPath({
    output: opts.output,
    nowMs,
    includedAssets: plan.included,
    stateDir: plan.stateDir,
  });

  if (plan.included.length === 0) {
    throw new Error("No local OpenClaw state was found to export for migration.");
  }

  const canonicalOutputPath = await canonicalizePathForContainment(outputPath);
  const overlappingAsset = plan.included.find((asset) =>
    isPathWithin(canonicalOutputPath, asset.sourcePath),
  );
  if (overlappingAsset) {
    throw new Error(
      `Output must not be written inside a source path: ${outputPath} is inside ${overlappingAsset.sourcePath}`,
    );
  }

  if (!opts.dryRun) {
    try {
      await fs.access(outputPath);
      throw new Error(`Refusing to overwrite existing archive: ${outputPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  }

  // Resolve agent ids from included assets.
  const agentIds = [...new Set(plan.included.filter((a) => a.agentId).map((a) => a.agentId!))];

  const warnings: string[] = [];

  // Warn when --strip-secrets is used but credentials/sessions are still included.
  if (stripSecrets) {
    const hasCredentials = plan.included.some((a) => a.kind === "credentials");
    const hasSessions = plan.included.some((a) => a.kind === "agents");
    if (hasCredentials || hasSessions) {
      const parts: string[] = [];
      if (hasCredentials) {
        parts.push("credentials (OAuth tokens)");
      }
      if (hasSessions) {
        parts.push("agent session data");
      }
      warnings.push(
        `--strip-secrets only redacts the JSON config file. ${parts.join(" and ")} are exported unredacted. Use --include to exclude them if sharing this archive.`,
      );
    }
  }

  const createdAt = new Date(nowMs).toISOString();
  const result: MigrateExportResult = {
    createdAt,
    archiveRoot,
    archivePath: outputPath,
    dryRun: Boolean(opts.dryRun),
    components,
    agents: agentIds,
    stripSecrets,
    assets: plan.included,
    skipped: plan.skipped,
    warnings,
  };

  if (opts.dryRun) {
    return result;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-"));
  const manifestPath = path.join(tempDir, "manifest.json");
  const tempArchivePath = `${outputPath}.${randomUUID()}.tmp`;

  try {
    const manifest = buildManifest({
      createdAt,
      archiveRoot,
      components,
      agents: agentIds,
      assets: result.assets,
      skipped: result.skipped,
      stateDir: plan.stateDir,
      configPath: plan.configPath,
      oauthDir: plan.oauthDir,
      workspaceDirs: plan.workspaceDirs,
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // If stripping secrets, create a redacted copy of the config file.
    let configOverridePath: string | undefined;
    if (stripSecrets) {
      const configAsset = result.assets.find((a) => a.kind === "config");
      if (configAsset) {
        const originalContent = await fs.readFile(configAsset.sourcePath, "utf8");
        const redacted = redactConfigSecrets(originalContent);
        configOverridePath = path.join(tempDir, "openclaw-redacted.json");
        await fs.writeFile(configOverridePath, redacted, "utf8");
      }
    }

    // Build file list for tar, replacing the config file with the redacted version if needed.
    const fileList = [manifestPath];
    for (const asset of result.assets) {
      if (stripSecrets && asset.kind === "config" && configOverridePath) {
        fileList.push(configOverridePath);
      } else {
        fileList.push(asset.sourcePath);
      }
    }

    await tar.c(
      {
        file: tempArchivePath,
        gzip: true,
        portable: true,
        preservePaths: true,
        // Do not globally dereference symlinks (follow: true), because
        // workspaces may contain symlinks pointing outside the exported
        // asset roots, which would silently include external data.
        // Symlinks are preserved in the archive and safely skipped by
        // the importer's onReadEntry handler.
        onWriteEntry: (entry) => {
          // Remap the config override path back to the original config source path.
          // Normalize to forward slashes for comparison since node-tar normalizes
          // entry paths to "/" on Windows while path.join uses backslashes.
          const normalizedEntryPath = entry.path.replaceAll("\\", "/");
          const normalizedOverride = configOverridePath?.replaceAll("\\", "/");
          if (stripSecrets && normalizedOverride && normalizedEntryPath === normalizedOverride) {
            const configAsset = result.assets.find((a) => a.kind === "config");
            if (configAsset) {
              entry.path = buildMigrateArchivePath(archiveRoot, configAsset.sourcePath);
              return;
            }
          }
          entry.path = remapArchiveEntryPath({
            entryPath: entry.path,
            manifestPath,
            archiveRoot,
          });
        },
      },
      fileList,
    );

    await publishTempArchive({ tempArchivePath, outputPath });
  } finally {
    await fs.rm(tempArchivePath, { force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return result;
}
