import fs from "node:fs/promises";
import path from "node:path";
import { appendCronRunLogToSqlite, parseAllRunLogEntries } from "../../../cron/run-log.js";
import { pathExists, root as fsRoot } from "../../../infra/fs-safe.js";

export async function legacyCronRunLogFilesExist(storePath: string): Promise<boolean> {
  const runsDir = path.resolve(path.dirname(path.resolve(storePath)), "runs");
  if (!(await pathExists(runsDir))) {
    return false;
  }
  const runsRoot = await fsRoot(runsDir).catch(() => null);
  if (!runsRoot) {
    return false;
  }
  const files = await runsRoot.list(".", { withFileTypes: true }).catch(() => []);
  return files.some((entry) => entry.isFile && entry.name.endsWith(".jsonl"));
}

export async function importLegacyCronRunLogFilesToSqlite(params: {
  legacyStorePath: string;
  storeKey: string;
  opts?: { maxBytes?: number; keepLines?: number };
}): Promise<{ imported: number; files: number; removedDir?: string }> {
  const runsDir = path.resolve(path.dirname(path.resolve(params.legacyStorePath)), "runs");
  if (!(await pathExists(runsDir))) {
    return { imported: 0, files: 0 };
  }
  const runsRoot = await fsRoot(runsDir).catch(() => null);
  if (!runsRoot) {
    return { imported: 0, files: 0 };
  }
  const files = (await runsRoot.list(".", { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);
  let imported = 0;
  for (const fileName of files) {
    const raw = await runsRoot.readText(fileName).catch(() => "");
    for (const entry of parseAllRunLogEntries(raw)) {
      await appendCronRunLogToSqlite(params.storeKey, entry, params.opts);
      imported++;
    }
    await fs.rm(path.join(runsDir, fileName), { force: true }).catch(() => undefined);
  }
  let removedDir: string | undefined;
  try {
    const remaining = await runsRoot.list(".", { withFileTypes: true });
    if (remaining.length === 0) {
      await fs.rmdir(runsDir);
      removedDir = runsDir;
    }
  } catch {
    // best-effort cleanup only
  }
  return { imported, files: files.length, removedDir };
}
