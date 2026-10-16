import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { hasErrnoCode } from "./errno.js";

export class RetiredStateFormatError extends Error {
  override name = "RetiredStateFormatError";
}

export function createRetiredStateInspectionError(
  filePath: string,
  cause: unknown,
): RetiredStateFormatError {
  // Admission must refuse an uninspected source instead of falling back to the installed driver.
  return new RetiredStateFormatError(
    `Cannot inspect potentially retired state at ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
      "The files were left unchanged. Correct the source path or restore access, then retry the upgrade.",
    { cause },
  );
}

export function assertNoRetiredStateFiles(label: string, paths: readonly string[]): void {
  const existing = paths.filter((filePath) => {
    try {
      // A broken link still owns an operator-selected source; do not silently ignore it.
      fs.lstatSync(filePath);
      return true;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw createRetiredStateInspectionError(filePath, error);
    }
  });
  if (existing.length === 0) {
    return;
  }
  throw new RetiredStateFormatError(
    `${label}: retired files whose last writer predates July 1, 2026: ${existing.join(", ")}. ` +
      `The files were left unchanged. Upgrade through OpenClaw 2026.9.7, run "${formatCliCommand("openclaw doctor --fix")}" on the original host, then retry this upgrade.`,
  );
}
