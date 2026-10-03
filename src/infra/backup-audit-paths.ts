import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";

const LEGACY_AUDIT_PATHS = [
  { directory: "logs", basename: "config-audit.jsonl" },
  // Beta installs also left system-agent audit migration artifacts.
  { directory: "audit", basename: "system-agent.jsonl" },
  { directory: "audit", basename: "crestodian.jsonl" },
].map(({ directory, basename }) => {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return {
    directory,
    pattern: new RegExp(
      `^(?:${escaped}|\\.${escaped}\\.doctor-importing(?:\\.(?:[2-9]|[1-9][0-9]+))?|${escaped}\\.migrated(?:\\.(?:[2-9]|[1-9][0-9]+))?\\.raw(?:\\.doctor-scrub-(?:progress|restore|staging))?)$`,
      "u",
    ),
  };
});

/** Raw audit artifacts inherit their export exclusion after quarantine. */
export function isLegacyAuditMigrationBackupPath(sourcePath: string, stateDir: string): boolean {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(sourcePath));
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return false;
  }
  const directory = path.dirname(relativePath);
  const basename = path.basename(relativePath);
  const quarantineIndex = basename.indexOf(".quarantined-");
  const originalBasename = quarantineIndex < 0 ? basename : basename.slice(0, quarantineIndex);
  return LEGACY_AUDIT_PATHS.some(
    (logical) => directory === logical.directory && logical.pattern.test(originalBasename),
  );
}

export async function hasLegacyAuditBackupSources(stateDir: string): Promise<boolean> {
  for (const { directory } of LEGACY_AUDIT_PATHS) {
    let entries: string[];
    const directoryPath = path.join(stateDir, directory);
    try {
      entries = await fs.readdir(directoryPath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (
      entries.some((entry) =>
        isLegacyAuditMigrationBackupPath(path.join(directoryPath, entry), stateDir),
      )
    ) {
      return true;
    }
  }
  return false;
}
