import fs from "node:fs/promises";
import path from "node:path";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { root as safeRoot } from "./fs-safe.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { hasPendingUpdateRecoverySeal } from "./update-recovery-capture-seal.js";
import { getUpdateRunAsync } from "./update-run-reader.js";

async function statOrMissing(value: string) {
  try {
    return await fs.lstat(value);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

const STANDALONE_DOCTOR_CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Only sealed, unassociated standalone originals are eligible for retirement. */
export async function retireExpiredStandaloneDoctorCaptures(params: {
  stateDir: string;
  keepRunId: string;
  now?: number;
  assertCurrent: () => void;
}): Promise<{ retired: string[]; warnings: string[] }> {
  const retired: string[] = [];
  const warnings: string[] = [];
  const root = resolveUpdateCaptureRoot(params.stateDir);
  const now = params.now ?? Date.now();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      warnings.push(
        `Standalone Doctor capture retirement unavailable at ${root}: ${formatErrorMessage(error)}`,
      );
    }
    return { retired, warnings };
  }
  for (const name of names.toSorted()) {
    if (
      name === params.keepRunId ||
      !/^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(name)
    ) {
      continue;
    }
    const directory = path.join(root, name);
    try {
      const entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (
        (await hasPendingUpdateRecoverySeal(directory)) ||
        !(await statOrMissing(path.join(directory, "manifest.json")))
      ) {
        continue;
      }
      const source = await safeRoot(directory, { symlinks: "reject", hardlinks: "reject" });
      const manifest = parseUpdateRecoveryBackupManifest(
        await source.readText("manifest.json", { maxBytes: 128 * 1024 * 1024 }),
      );
      const createdAt = Date.parse(manifest.createdAt);
      if (
        manifest.runId !== name ||
        manifest.schemaVersion !== 2 ||
        manifest.generation?.kind !== "baseline" ||
        !Number.isFinite(createdAt) ||
        now - createdAt <= STANDALONE_DOCTOR_CAPTURE_RETENTION_MS ||
        (await statOrMissing(path.join(directory, "outcome.json"))) ||
        (await getUpdateRunAsync(manifest.runId, {
          path: path.join(params.stateDir, "state", "openclaw.sqlite"),
        })) !== undefined
      ) {
        continue;
      }
      if (await hasPendingUpdateRecoverySeal(directory)) {
        continue;
      }
      params.assertCurrent();
      await fs.rm(directory, { recursive: true });
      retired.push(directory);
    } catch (error) {
      warnings.push(
        `Standalone Doctor capture retained at ${directory}: ${formatErrorMessage(error)}`,
      );
    }
  }
  return { retired, warnings };
}
