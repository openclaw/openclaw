import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { root } from "@openclaw/fs-safe";

const RESULT_FILE_RECEIPT = '"openclaw-update-state-result-file-v1"';

export function createUpdateStateResultPath(stagingRoot: string): string {
  return path.join(stagingRoot, `inspection-result-${randomUUID()}.json`);
}

/** Opt-in keeps current workers compatible with installed drivers that require stdout JSON. */
export async function writeUpdateStateResult(value: unknown, resultPath?: string): Promise<void> {
  const json = JSON.stringify(value);
  if (!resultPath) {
    process.stdout.write(json);
    return;
  }
  // Discovery and backup receipts can outgrow stdout, just like retained-runtime file lists.
  await fs.writeFile(resultPath, json, { mode: 0o600, flag: "wx" });
  process.stdout.write(RESULT_FILE_RECEIPT);
}

/** Call only after successful process settlement; the staging owner retains uncertain writes. */
export async function readUpdateStateResult(stdout: string, resultPath: string): Promise<string> {
  if (stdout !== RESULT_FILE_RECEIPT) {
    // Published workers predating this request option still return their JSON on stdout.
    return stdout;
  }
  try {
    const directory = await root(path.dirname(resultPath), {
      symlinks: "reject",
      hardlinks: "reject",
    });
    return await directory.readText(path.basename(resultPath), { maxBytes: 128 * 1024 * 1024 });
  } finally {
    await fs.rm(resultPath, { force: true });
  }
}
