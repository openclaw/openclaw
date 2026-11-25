// Write-ahead restore intent for rename-based state upgrades.
import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { truncateSqliteWal } from "../infra/sqlite-wal-checkpoint.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readTrial, resolvePrefix, type Trial } from "../update/store.js";
import { fsyncPath, isSqliteFile, type UpgradePlan } from "./state-upgrade-tree.js";

type RestoreFile = { readonly live: string; readonly preimage: string | null };
type RestoreManifest = {
  readonly v: 1;
  readonly runId: string;
  readonly files: readonly RestoreFile[];
};
type RestoreImageReport = { files: number; symlinks: number };
export type StateUpgradeRestore = {
  file: string;
  runId: string;
  generation: string;
  existing: RestoreManifest | undefined;
};
const COMPANIONS = ["-wal", "-shm", "-journal", ".seal"] as const;
const restoreCapture = resolveGlobalSingleton<{
  value: { file: string; manifest: RestoreManifest } | undefined;
}>(Symbol.for("openclaw.stateUpgradeRestoreCapture"), () => ({ value: undefined }));

function invalid(file: string, cause?: unknown): Error {
  return new Error(
    `Invalid update restore manifest ${file}. Preserve it and run openclaw triage before retrying the update.`,
    { cause },
  );
}

function readManifest(file: string): RestoreManifest | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw invalid(file, error);
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("v" in value) ||
    value.v !== 1 ||
    !("runId" in value) ||
    typeof value.runId !== "string" ||
    !value.runId ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw invalid(file);
  }
  const files: RestoreFile[] = [];
  const seen = new Set<string>();
  const entries: unknown[] = value.files;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("live" in entry) ||
      typeof entry.live !== "string" ||
      !path.isAbsolute(entry.live) ||
      seen.has(entry.live) ||
      !("preimage" in entry) ||
      (entry.preimage !== null &&
        (typeof entry.preimage !== "string" || !path.isAbsolute(entry.preimage)))
    ) {
      throw invalid(file);
    }
    seen.add(entry.live);
    files.push({ live: entry.live, preimage: entry.preimage });
  }
  return { v: 1, runId: value.runId, files };
}

function removeImages(manifest: RestoreManifest): void {
  for (const { preimage } of manifest.files) {
    if (preimage !== null) {
      // rm without recursive never follows a leaf symlink or removes a directory.
      fs.rmSync(preimage, { force: true });
    }
  }
}

/** Capture the candidate's authority once, before allocating private migration work. */
export async function beginStateUpgradeRestore(
  env: NodeJS.ProcessEnv,
  knownTrial?: Trial | null,
): Promise<StateUpgradeRestore | undefined> {
  const prefix = resolvePrefix(env);
  const trial = knownTrial === undefined ? await readTrial(prefix) : knownTrial;
  if (trial?.phase !== "trial") {
    return undefined;
  }
  // The launcher selected this target before fork. Its prepared release owns the
  // journal, including retries initiated by preparers that know no manifest.
  const file = path.join(path.dirname(path.resolve(prefix, trial.target)), ".restore");
  if (!trial.runId || /[\\/\0]/u.test(trial.runId)) {
    throw invalid(file);
  }
  const existing = readManifest(file);
  return {
    file,
    runId: trial.runId,
    generation: `restore-${trial.runId}`,
    existing,
  };
}

function checkpointOriginal(file: string): void {
  retireSqliteDatabaseAdmissionForPath(file);
  try {
    const db = openNodeSqliteDatabase(file);
    try {
      truncateSqliteWal(db, file);
    } finally {
      db.close();
    }
  } finally {
    retireSqliteDatabaseAdmissionForPath(file);
  }
  // The checkpoint folded committed frames into main. No joined consumer may
  // recreate these companions before applyPlan replaces the canonical inode.
  for (const suffix of COMPANIONS) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

/** Publish before writePlan: a durable swap plan may be replayed on the next boot. */
export function publishStateUpgradeRestore(
  restore: StateUpgradeRestore | undefined,
  plan: Pick<UpgradePlan, "ops">,
  resuming = false,
): RestoreImageReport {
  const report: RestoreImageReport = { files: 0, symlinks: 0 };
  if (!restore) {
    return report;
  }
  const planned = plan.ops.map((op) => {
    const stat = fs.lstatSync(op.live, { throwIfNoEntry: false });
    return { op, stat, sqlite: stat?.isFile() === true && isSqliteFile(op.live) };
  });
  const companions = new Set<string>();
  for (const { op, sqlite } of planned) {
    const original = restore.existing?.files.find((entry) => entry.live === op.live)?.preimage;
    const originalStat = original ? fs.lstatSync(original, { throwIfNoEntry: false }) : undefined;
    if (
      sqlite ||
      (op.next && isSqliteFile(op.next)) ||
      (original && originalStat?.isFile() && isSqliteFile(original))
    ) {
      for (const suffix of COMPANIONS) {
        companions.add(`${op.live}${suffix}`);
      }
    }
  }
  if (restore.existing) {
    const files = new Map(restore.existing.files.map((entry) => [entry.live, entry]));
    for (const { live, preimage } of restore.existing.files) {
      const image =
        preimage === null ? undefined : fs.lstatSync(preimage, { throwIfNoEntry: false });
      if (preimage !== null && (!image || image.isDirectory())) {
        throw new Error(
          `Update recovery image for ${live} is missing or invalid. Preserve the restore manifest and run openclaw triage.`,
        );
      }
    }
    if (
      planned.some(({ op }) => !files.has(op.live)) ||
      [...companions].some((live) => !files.has(live) || files.get(live)?.preimage !== null)
    ) {
      throw new Error(
        "The update's immutable restore manifest does not cover this migration plan. Run openclaw triage before retrying.",
      );
    }
    restoreCapture.value = { file: restore.file, manifest: restore.existing };
    return report;
  }
  if (resuming) {
    throw new Error(
      "An interrupted update plan has no matching restore manifest. Preserve its recovery files and run openclaw triage.",
    );
  }
  const files: RestoreFile[] = [];
  const images: string[] = [];
  let published = false;
  try {
    for (const { op, stat, sqlite } of planned) {
      if (companions.has(op.live)) {
        continue;
      }
      if (!stat) {
        files.push({ live: op.live, preimage: null });
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        throw new Error(
          `Update recovery cannot preserve directory ${op.live}. Run openclaw triage before retrying.`,
        );
      }
      const preimage = `${op.live}.pre-${restore.generation}`;
      const previous = fs.lstatSync(preimage, { throwIfNoEntry: false });
      if (
        previous &&
        ((!previous.isFile() && !previous.isSymbolicLink()) ||
          previous.isSymbolicLink() !== stat.isSymbolicLink())
      ) {
        throw invalid(restore.file);
      }
      images.push(preimage);
      if (!previous) {
        if (stat.isSymbolicLink()) {
          fs.symlinkSync(fs.readlinkSync(op.live), preimage);
          report.symlinks++;
        } else {
          if (sqlite) {
            // Fold committed WAL frames into the single-file recovery image.
            checkpointOriginal(op.live);
          }
          fsyncPath(op.live);
          // The frozen launcher restores the original inode via its legacy name.
          // A second hard link would make the restored store fail startup admission.
          const temporary = `${preimage}.tmp`;
          fs.rmSync(temporary, { force: true });
          try {
            fs.copyFileSync(
              op.live,
              temporary,
              fs.constants.COPYFILE_FICLONE | fs.constants.COPYFILE_EXCL,
            );
            fsyncPath(temporary);
            fs.renameSync(temporary, preimage);
          } catch (error) {
            fs.rmSync(temporary, { force: true });
            throw error;
          }
          report.files++;
        }
      }
      fsyncPath(path.dirname(preimage), true);
      files.push({ live: op.live, preimage });
    }
    for (const live of companions) {
      files.push({ live, preimage: null });
    }
    const manifest: RestoreManifest = { v: 1, runId: restore.runId, files };
    const temporary = `${restore.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
    fsyncPath(temporary);
    fs.renameSync(temporary, restore.file);
    published = true;
    fsyncPath(path.dirname(restore.file), true);
    restore.existing = manifest;
    restoreCapture.value = { file: restore.file, manifest };
    return report;
  } finally {
    if (!published) {
      for (const image of images) {
        fs.rmSync(image, { force: true });
      }
    }
  }
}

/** Consume this process's published receipt only after confirmed committed IPC. */
export function takeStateUpgradeRestoreCleanup(): (() => string[]) | undefined {
  const captured = restoreCapture.value;
  restoreCapture.value = undefined;
  if (!captured) {
    return undefined;
  }
  return () => {
    try {
      removeImages(captured.manifest);
      return [];
    } catch (error) {
      return [
        `Update recovery images were retained: ${formatErrorMessage(error)}. Run openclaw triage to inspect ${captured.file}.`,
      ];
    }
  };
}
