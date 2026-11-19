import fs from "node:fs/promises";
import path from "node:path";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { Root } from "./fs-safe.js";
import type { LegacyAuditLogSource } from "./state-migrations.audit-logs.types.js";
import type { LegacyMigrationMoveUnavailableError } from "./state-migrations.no-replace-move.js";

/** Destination-first names reserved by the audit migration, in recovery order. */
export async function legacyAuditMoveCandidates(
  root: Root,
  source: LegacyAuditLogSource,
): Promise<Array<{ retained: string; removed: string }>> {
  const logical = path.relative(path.resolve(root.rootDir), source.logicalSourcePath);
  const directory = path.dirname(logical);
  const basename = path.basename(logical);
  const escaped = escapeRegExp(basename);
  const generation = "(?:\\.([2-9]|[1-9][0-9]+))?";
  const claimPattern = new RegExp(`^\\.${escaped}\\.doctor-importing${generation}$`, "u");
  const rawPattern = new RegExp(`^${escaped}\\.migrated${generation}\\.raw$`, "u");
  const entries = await fs.readdir(await root.resolve(directory));
  const pairs: Array<{ retained: string; removed: string }> = [];
  const claims: Array<{ retained: string; removed: string }> = [];
  for (const entry of entries) {
    const raw = rawPattern.exec(entry);
    if (raw) {
      const rawPath = path.join(directory, entry);
      const quarantinePattern = new RegExp(
        `^${escapeRegExp(entry)}\\.quarantined-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
        "u",
      );
      for (const quarantine of entries.filter((candidate) => quarantinePattern.test(candidate))) {
        pairs.push({ retained: path.join(directory, quarantine), removed: rawPath });
      }
      pairs.push(
        {
          retained: rawPath,
          removed: path.join(
            directory,
            `.${basename}.doctor-importing${raw[1] ? `.${raw[1]}` : ""}`,
          ),
        },
        { retained: rawPath, removed: logical },
      );
    } else if (claimPattern.test(entry)) {
      claims.push({ retained: path.join(directory, entry), removed: logical });
    }
  }
  return [...pairs, ...claims];
}

export function formatLegacyAuditMoveWarning(
  error: LegacyMigrationMoveUnavailableError,
  stateDir: string,
): string {
  const command =
    process.platform === "win32"
      ? `& { $previous=$env:OPENCLAW_STATE_DIR; try { $env:OPENCLAW_STATE_DIR=${quotePowerShellArg(stateDir)}; openclaw doctor --fix } finally { $env:OPENCLAW_STATE_DIR=$previous } }`
      : `env OPENCLAW_STATE_DIR=${quoteCliArg(stateDir)} openclaw doctor --fix`;
  return `Skipped legacy audit migration: the filesystem rejects native no-replace rename and hard links (${error.code}). Could not move ${error.sourcePath}; preserved the audit inode without copying. After restoring hard-link support (or moving the complete state directory to a compatible filesystem with the Gateway and all CLI writers stopped), run: ${command}. Other repairs can continue.`;
}

export function legacyAuditClaimPathForArchive(
  sourcePath: string,
  sanitizedArchivePath: string,
): string {
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

export type AuditArchiveRelativePaths = {
  sanitized: string;
  raw: string;
  resumeSanitized: boolean;
};

export async function resolveAuditArchiveRelativePaths(
  root: Root,
  sourceRelativePath: string,
): Promise<AuditArchiveRelativePaths> {
  const directoryPath = await root.resolve(path.dirname(sourceRelativePath));
  const baseName = escapeRegExp(path.basename(sourceRelativePath));
  const archivePattern = new RegExp(
    `^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?(?:\\.raw)?$`,
    "u",
  );
  const claimPattern = new RegExp(
    `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
    "u",
  );
  let latestGeneration = 0n;
  for (const entry of await fs.readdir(directoryPath)) {
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
