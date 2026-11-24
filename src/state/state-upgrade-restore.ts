// Write-ahead restore intent for rename-based state upgrades. Hard-linked images
// are immutable only because the swap replaces, rather than writes, the live inode.
import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { readTrial, resolvePrefix, type Trial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import { fsyncPath, isSqliteFile, type UpgradePlan } from "./state-upgrade-tree.js";

type RestoreFile = { live: string; preimage: string | null };
type RestoreManifest = { v: 1; runId: string; files: RestoreFile[] };
export type StateUpgradeRestore = {
  file: string;
  runId: string;
  generation: string;
  existing: RestoreManifest | undefined;
};
const COMPANIONS = ["-wal", "-shm", "-journal", ".seal"] as const;
const LINK_UNAVAILABLE = new Set(["EXDEV", "EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EMLINK"]);

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
    /[\\/\0]/u.test(value.runId) ||
    value.runId === "." ||
    value.runId === ".." ||
    !("files" in value) ||
    !Array.isArray(value.files)
  ) {
    throw invalid(file);
  }
  const files: RestoreFile[] = [];
  const seen = new Set<string>();
  for (const entry of value.files as unknown[]) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("live" in entry) ||
      typeof entry.live !== "string" ||
      !path.isAbsolute(entry.live) ||
      seen.has(entry.live) ||
      !("preimage" in entry) ||
      (entry.preimage !== null &&
        (typeof entry.preimage !== "string" ||
          entry.preimage !== `${entry.live}.pre-restore-${value.runId}`))
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
  if (
    trial?.phase !== "trial" ||
    (trial.buildId ? trial.buildId !== resolveRuntimeServiceBuildId() : trial.version !== VERSION)
  ) {
    return undefined;
  }
  const file = path.join(prefix, "releases", ".restore");
  if (!trial.runId || /[\\/\0]/u.test(trial.runId) || trial.runId === "." || trial.runId === "..") {
    throw invalid(file);
  }
  const existing = readManifest(file);
  if (existing && existing.runId !== trial.runId) {
    removeImages(existing);
  }
  return {
    file,
    runId: trial.runId,
    generation: `restore-${trial.runId}`,
    existing: existing?.runId === trial.runId ? existing : undefined,
  };
}

function checkpointOriginal(file: string): void {
  retireSqliteDatabaseAdmissionForPath(file);
  try {
    const db = openNodeSqliteDatabase(file);
    try {
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (checkpoint?.busy !== 0) {
        throw new Error(
          `Cannot checkpoint ${file} for update recovery. Stop other processes using this database and retry the update.`,
        );
      }
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
): { linked: number; copied: string[]; symlinks: number } {
  const report = { linked: 0, copied: [] as string[], symlinks: 0 };
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
            // Logical contents do not change. This must precede the immutable link.
            checkpointOriginal(op.live);
          }
          fsyncPath(op.live);
          try {
            fs.linkSync(op.live, preimage);
            report.linked++;
          } catch (error) {
            // Same-directory images normally share a filesystem; file mounts and
            // filesystems without hard links need the byte-copy fallback.
            // SAFETY: node:fs reports link failures as NodeJS.ErrnoException.
            const code = (error as NodeJS.ErrnoException).code;
            if (!code || !LINK_UNAVAILABLE.has(code)) {
              throw error;
            }
            const temporary = `${preimage}.tmp`;
            try {
              fs.copyFileSync(op.live, temporary);
              fsyncPath(temporary);
              fs.renameSync(temporary, preimage);
            } finally {
              fs.rmSync(temporary, { force: true });
            }
            report.copied.push(`${op.live} (${code})`);
          }
        }
      }
      if (stat.isFile()) {
        fsyncPath(preimage);
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
    return report;
  } finally {
    if (!published) {
      for (const image of images) {
        fs.rmSync(image, { force: true });
      }
    }
  }
}

/** Only the caller that received committed IPC may retire that run's images. */
export function cleanupStateUpgradeRestore(runId: string, env: NodeJS.ProcessEnv): string[] {
  const file = path.join(resolvePrefix(env), "releases", ".restore");
  try {
    const manifest = readManifest(file);
    if (manifest?.runId === runId) {
      removeImages(manifest);
    }
    // Leave the bounded receipt: unlinking this fixed path could remove a newer
    // run's manifest after our read. The next admitted writer replaces it.
    return [];
  } catch (error) {
    return [
      `Update recovery images were retained: ${formatErrorMessage(error)}. Run openclaw triage to inspect ${file}.`,
    ];
  }
}
