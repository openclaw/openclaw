import fs from "node:fs";
import { formatErrorMessage, hasErrnoCode } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export function canReadUpgradeFile(
  file: string,
  requiredDatabase: boolean,
  log?: { warn: (message: string) => void },
): boolean {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch (error) {
    if (!hasErrnoCode(error, "EACCES") && !hasErrnoCode(error, "EPERM")) {
      throw error;
    }
    if (requiredDatabase) {
      throw new Error(
        `State upgrade refused: required database file ${file} is unreadable. Nothing live was changed. Run openclaw doctor --fix under offline maintenance, then start the Gateway again.`,
        { cause: error },
      );
    }
    (log ?? createSubsystemLogger("state/upgrade")).warn(
      `Skipping unreadable state upgrade file ${file}: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

export function readableCompanionBytes(
  source: string,
  requiredDatabase: boolean,
  log?: { warn: (message: string) => void },
): number | undefined {
  let bytes = 0;
  for (const suffix of ["-wal", "-journal"]) {
    const file = `${source}${suffix}`;
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    if (!canReadUpgradeFile(file, requiredDatabase, log)) {
      return undefined;
    }
    bytes += stat.size;
  }
  return bytes;
}
