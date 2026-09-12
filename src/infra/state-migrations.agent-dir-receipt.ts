import fs from "node:fs";
import path from "node:path";
import { isMissingPathError } from "./errno.js";
import { replaceFileAtomicSync } from "./replace-file.js";

export const LEGACY_AGENT_DIR_RECEIPT = ".legacy-agent-dir-migration.json";

function receiptContent(source: string, target: string): string {
  return `${JSON.stringify({ version: 1, source, target })}\n`;
}

export function hasCompletedLegacyAgentDirMigration(source: string, target: string): boolean {
  try {
    return (
      fs.lstatSync(path.join(target, LEGACY_AGENT_DIR_RECEIPT)).isFile() &&
      fs.readFileSync(path.join(target, LEGACY_AGENT_DIR_RECEIPT), "utf8") ===
        receiptContent(fs.realpathSync(source), fs.realpathSync(target))
    );
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

// The migration passes its resolved roots only after moving or quarantining every source entry.
export function recordCompletedLegacyAgentDirMigration(sourceRoot: string, targetRoot: string) {
  const filePath = path.join(targetRoot, LEGACY_AGENT_DIR_RECEIPT);
  const content = receiptContent(sourceRoot, targetRoot);
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing?.isFile() && fs.readFileSync(filePath, "utf8") === content) {
    return;
  }
  const requireMissingReceipt = () => {
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) {
      throw new Error(
        `Preserved unrecognized migration receipt at ${filePath}; inspect it before moving it aside`,
      );
    }
  };
  requireMissingReceipt();
  replaceFileAtomicSync({
    filePath,
    content,
    mode: 0o600,
    dirMode: fs.statSync(targetRoot).mode & 0o7777,
    tempPrefix: ".legacy-agent-dir-migration",
    beforeRename: requireMissingReceipt,
    syncTempFile: true,
    syncParentDir: true,
  });
}
