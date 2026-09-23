import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMissingPathError } from "./errno.js";
import { isPathInside } from "./path-guards.js";
import { replaceFileAtomicSync } from "./replace-file.js";

export const LEGACY_AGENT_DIR_RECEIPT = ".legacy-agent-dir-migration.json";

// Shipped standalone SDKs used the OS home, independently of OpenClaw state/home overrides.
export function resolveLegacyStandaloneAgentDir(homedir: () => string = os.homedir): string {
  return path.join(homedir(), ".openclaw", "agent");
}

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

export function legacyAgentQuarantineNotices(
  stateDir: string,
  agentId: string,
  now = Date.now(),
): string[] {
  let stateRoot: string;
  try {
    stateRoot = fs.realpathSync(stateDir);
  } catch {
    return [];
  }
  // Released migrations placed these artifacts under agents/<id>; keep their cleanup hint.
  return [stateRoot, path.join(stateRoot, "agents", agentId)].flatMap((parent) => {
    try {
      const resolvedParent = fs.realpathSync(parent);
      if (resolvedParent !== stateRoot && !isPathInside(stateRoot, resolvedParent)) {
        return [];
      }
      const old = fs.readdirSync(resolvedParent, { withFileTypes: true }).filter((entry) => {
        const timestamp = /^agent\.legacy-(\d+)(?:-|$)/.exec(entry.name)?.[1];
        return (
          entry.isDirectory() && timestamp && now - Number(timestamp) > 30 * 24 * 60 * 60 * 1000
        );
      });
      return old.length > 0
        ? [
            `${old.length} legacy agent quarantine(s) older than 30 days in ${resolvedParent}; inspect agent.legacy-* and remove only copies you no longer need.`,
          ]
        : [];
    } catch {
      return [];
    }
  });
}
