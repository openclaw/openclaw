// A raised reader floor needs an independent pre-image before in-place migration.
// Build-named images remain readable by the launcher already installed on users' hosts.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { copySqliteFile } from "../infra/sqlite-file-copy.js";
import { truncateSqliteWal } from "../infra/sqlite-wal-checkpoint.js";
import { clonePostgresUpgrade, retirePostgresUpgrade } from "../snapshot/database-backup.js";
import { readTrial, resolvePrefix, type Trial } from "../update/store.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import type { DatabaseTarget } from "./state-upgrade-databases.js";

type RestoreFile = { readonly live: string; readonly preimage: string | null };
type RestoreManifest = {
  readonly v: 1;
  readonly runId: string;
  readonly files: readonly RestoreFile[];
};
export type StateUpgradeRestore = {
  file: string;
  stateDir: string;
  runId: string;
  generation: string;
  existing: RestoreManifest | undefined;
};
const COMPANIONS = ["-wal", "-shm", "-journal", ".seal"] as const;

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

/** The prepared release owns one immutable restore receipt, including across retry. */
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
    stateDir: path.dirname(prefix),
    runId: trial.runId,
    generation: resolveRuntimeServiceBuildId() ?? VERSION,
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
  if (
    ["-wal", "-journal"].some(
      (suffix) => (fs.statSync(`${file}${suffix}`, { throwIfNoEntry: false })?.size ?? 0) > 0,
    )
  ) {
    throw new Error(
      `Cannot checkpoint ${file} for update recovery. Stop its other readers and retry openclaw update.`,
    );
  }
}

function writeRestoreManifest(restore: StateUpgradeRestore, manifest: RestoreManifest): void {
  const temporary = `${restore.file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
  fsyncPath(temporary);
  fs.renameSync(temporary, restore.file);
  fsyncPath(path.dirname(restore.file), true);
  restore.existing = manifest;
}

function writeLegacyAdditions(restore: StateUpgradeRestore, files: readonly RestoreFile[]): void {
  const ops: Array<{ kind: "add"; live: string }> = [];
  for (const file of files) {
    if (file.preimage === null) {
      ops.push({ kind: "add", live: file.live });
    }
  }
  const applied = path.join(restore.stateDir, `.upgraded-${restore.generation}.json`);
  const temporary = `${applied}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ appVersion: restore.generation, ops }), {
    mode: 0o600,
  });
  fsyncPath(temporary);
  fs.renameSync(temporary, applied);
  fsyncPath(restore.stateDir, true);
}

function completeProspectiveFiles(
  restore: StateUpgradeRestore,
  manifest: RestoreManifest,
  prospective: ReadonlyMap<string, readonly string[]>,
): (() => void) | undefined {
  if (prospective.size === 0) {
    return undefined;
  }
  return () => {
    const unused = new Set<string>();
    for (const family of prospective.values()) {
      if (!family.some((file) => fs.existsSync(file))) {
        for (const file of family) {
          unused.add(file);
        }
      }
    }
    if (unused.size === 0) {
      return;
    }
    const narrowed = {
      ...manifest,
      files: manifest.files.filter((file) => !unused.has(file.live)),
    };
    // Complete while boot still owns custody. Later runtime creations are not trial additions.
    writeLegacyAdditions(restore, narrowed.files);
    writeRestoreManifest(restore, narrowed);
  };
}

/** Publish before mutation; complete before normal runtime can create prospective stores. */
export async function publishStateUpgradeRestore(
  restore: StateUpgradeRestore | undefined,
  plan: {
    targets: readonly { path: string; engine: DatabaseTarget["engine"] | "file" }[];
    config: OpenClawConfig;
  },
): Promise<(() => void) | undefined> {
  if (!restore) {
    return undefined;
  }
  const prospective = new Map<string, readonly string[]>();
  for (const target of plan.targets) {
    if (!fs.existsSync(target.path)) {
      const family = [target.path];
      if (target.engine !== "file") {
        for (const suffix of COMPANIONS) {
          family.push(`${target.path}${suffix}`);
        }
      }
      prospective.set(target.path, family);
    }
  }
  if (restore.existing) {
    const files = new Map(restore.existing.files.map((entry) => [entry.live, entry]));
    for (const { live, preimage } of restore.existing.files) {
      const image =
        preimage === null ? undefined : fs.lstatSync(preimage, { throwIfNoEntry: false });
      if (preimage !== null && !image?.isFile()) {
        throw new Error(
          `Update recovery image for ${live} is missing or invalid. Preserve the restore manifest and run openclaw triage.`,
        );
      }
    }
    for (const target of plan.targets) {
      const family = prospective.get(target.path);
      if (!files.has(target.path) && family) {
        // A successful boot narrowed unused additions; refresh only still-absent families.
        for (const live of family) {
          files.set(live, { live, preimage: null });
        }
      }
      if (
        !files.has(target.path) ||
        (target.engine !== "file" &&
          COMPANIONS.some((suffix) => files.get(`${target.path}${suffix}`)?.preimage !== null))
      ) {
        throw new Error(
          "The update's immutable restore manifest does not cover this migration plan. Run openclaw triage before retrying.",
        );
      }
    }
    if (files.size !== restore.existing.files.length) {
      const refreshed = { ...restore.existing, files: [...files.values()] };
      writeLegacyAdditions(restore, refreshed.files);
      writeRestoreManifest(restore, refreshed);
    }
    // Images stay immutable. An interrupted import retains its conservative original receipt.
    return completeProspectiveFiles(restore, restore.existing, prospective);
  }
  const files: RestoreFile[] = [];
  for (const target of plan.targets) {
    const live = target.path;
    const family = prospective.get(live);
    if (family) {
      for (const file of family) {
        files.push({ live: file, preimage: null });
      }
      continue;
    }
    const preimage = `${live}.pre-${restore.generation}`;
    const temporary = `${preimage}.tmp-${process.pid}`;
    if (target.engine === "postgres") {
      // The image anchor selects the preserved namespace. The live anchor and
      // namespace stay where they are and migrate through the existing engine.
      await clonePostgresUpgrade(live, temporary, plan.config);
      if (fs.existsSync(preimage)) {
        await retirePostgresUpgrade(
          preimage,
          plan.config,
          plan.targets.filter((entry) => entry.engine !== "file").map((entry) => entry.path),
        );
      }
    } else {
      if (target.engine === "sqlite") {
        checkpointOriginal(live);
      }
      fs.rmSync(temporary, { force: true });
      try {
        // Reuse #201716's native CoW/byte-copy primitive. A hard link cannot
        // protect an inode that the migration will write in place.
        await copySqliteFile(live, temporary, fs.lstatSync(live, { bigint: true }));
      } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
    }
    fsyncPath(temporary);
    fs.renameSync(temporary, preimage);
    fsyncPath(path.dirname(preimage), true);
    files.push({ live, preimage });
    if (target.engine !== "file") {
      for (const suffix of COMPANIONS) {
        files.push({ live: `${live}${suffix}`, preimage: null });
      }
    }
  }
  const manifest: RestoreManifest = { v: 1, runId: restore.runId, files };
  if (prospective.size > 0) {
    writeLegacyAdditions(restore, files);
  }
  writeRestoreManifest(restore, manifest);
  return completeProspectiveFiles(restore, manifest, prospective);
}

function fsyncPath(pathname: string, directory = false): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathname, directory ? "r" : "r+");
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows cannot open directories for fsync.
    // SAFETY: node:fs reports filesystem failures as NodeJS.ErrnoException.
    const code = (error as NodeJS.ErrnoException).code;
    if (!(directory && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** Existing generation retention: only inventoried images, never operator backups. */
export async function pruneGenerations(
  root: string,
  keepVersion: string,
  pinnedVersions: ReadonlySet<string>,
  ownedFiles: ReadonlySet<string>,
  postgres: { config: OpenClawConfig; activeAnchors: string[]; warn: (message: string) => void },
): Promise<string[]> {
  const removed: string[] = [];
  const keep = new Set([keepVersion, ...pinnedVersions]);
  const databases = new Set(postgres.activeAnchors);
  const generations: Array<{ absolute: string; retained: boolean; database: boolean }> = [];
  for (const directory of new Set([...ownedFiles].map((file) => path.dirname(file)))) {
    for (const name of fs.readdirSync(directory)) {
      const match = /^(.*)\.pre-([^/]+)$/u.exec(name);
      if (
        !match ||
        /\.pre-startup-migration-|\.scoped\.bak$|\.sqlite[^/]*\.bak$|^openclaw-media-persistence-recovery-/u.test(
          name,
        )
      ) {
        continue;
      }
      const [, original, generation] = match;
      const absolute = path.join(directory, name);
      if (ownedFiles.has(path.join(directory, original!)) && fs.lstatSync(absolute).isFile()) {
        generations.push({
          absolute,
          retained: keep.has(generation!),
          database: databases.has(path.join(directory, original!)),
        });
      }
    }
  }
  const retainedAnchors = [
    ...postgres.activeAnchors,
    ...generations
      .filter((entry) => entry.retained && entry.database)
      .map((entry) => entry.absolute),
  ].filter((file) => fs.existsSync(file));
  const protectedNamespaces = new Set(
    retainedAnchors.flatMap((file) => {
      const engine = readBackupEngine(file);
      return engine.engine === "postgres" ? [engine.namespace] : [];
    }),
  );
  for (const { absolute, retained, database } of generations) {
    if (retained) {
      continue;
    }
    const engine = database ? readBackupEngine(absolute) : undefined;
    if (engine?.engine === "postgres" && !protectedNamespaces.has(engine.namespace)) {
      try {
        await retirePostgresUpgrade(absolute, postgres.config, retainedAnchors);
      } catch (error) {
        postgres.warn(
          `Previous PostgreSQL recovery data was kept because cleanup could not finish: ${formatErrorMessage(error)}. Run openclaw doctor to inspect retained recovery data.`,
        );
        continue;
      }
    }
    fs.rmSync(absolute);
    removed.push(path.relative(root, absolute));
  }
  return removed;
}
