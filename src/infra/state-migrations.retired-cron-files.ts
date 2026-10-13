import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { createRetiredStateInspectionError } from "./state-migrations.retired-files.js";

export async function listRetiredCronStateFiles(storePath: string): Promise<string[]> {
  const resolved = path.resolve(storePath);
  const paths = [
    resolved,
    resolved.endsWith(".json")
      ? resolved.replace(/\.json$/, "-state.json")
      : `${resolved}-state.json`,
  ];
  const runsDir = path.join(path.dirname(resolved), "runs");
  try {
    const entry = (await fs.readdir(runsDir)).find((name) => name.endsWith(".jsonl"));
    if (entry) {
      paths.push(path.join(runsDir, entry));
    }
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      try {
        await fs.lstat(runsDir);
      } catch (inspectionError) {
        if (hasErrnoCode(inspectionError, "ENOENT")) {
          return paths;
        }
        throw createRetiredStateInspectionError(runsDir, inspectionError);
      }
    }
    throw createRetiredStateInspectionError(runsDir, error);
  }
  return paths;
}
