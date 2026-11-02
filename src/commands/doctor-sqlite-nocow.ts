/** Offline btrfs rewrites retain original SQLite files and WAL-aware backups. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot } from "@openclaw/fs-safe/root";
import { z } from "zod";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { copyFileHandle, hashFileDescriptorSync } from "../infra/file-descriptor.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { isSqlitePathOnBtrfs, setSqliteDirectoryNoCow } from "../infra/sqlite-wal-filesystem.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { DoctorMaintenanceRefusalError } from "../infra/update-doctor-result.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";
import { reconcileNoCowRecoveryIdentities } from "./doctor-sqlite-nocow-recovery-identity.js";

const TOOL_TIMEOUT_MS = 2_000;
const FUSER_MAX_PATHS = 2_000;
// Leave room for the inherited environment and argv pointers under Linux ARG_MAX.
const FUSER_MAX_PATH_BYTES = 64 * 1024;

function hasNoCow(pathname: string): boolean {
  const result = spawnSync("lsattr", ["-d", "--", pathname], {
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
  });
  const flags = result.stdout?.trim().split(/\s+/u)[0];
  if (result.error || result.status !== 0 || !flags || !/^[a-zA-Z-]+$/u.test(flags)) {
    throw new Error(
      "NOCOW check skipped: lsattr is unavailable or could not read file attributes.",
    );
  }
  return flags.includes("C");
}

export function inspectDoctorSqliteNoCow(paths: readonly string[]) {
  const result: { paths: string[]; notes: string[] } = { paths: [], notes: [] };
  for (const pathname of new Set(paths)) {
    try {
      if (!fs.existsSync(pathname) || !isSqlitePathOnBtrfs(pathname)) {
        continue;
      }
      if (
        !hasNoCow(path.dirname(pathname)) ||
        hasInterruptedRepair(path.dirname(pathname)) ||
        SIDECARS.some((suffix) => {
          const file = `${pathname}${suffix}`;
          return fs.existsSync(file) && !hasNoCow(file);
        })
      ) {
        result.paths.push(pathname);
        result.notes.push(
          `SQLite store on btrfs without NOCOW: ${pathname}. Run openclaw doctor --fix to rewrite it while the Gateway is stopped.`,
        );
      }
    } catch (error) {
      result.notes.push(`${pathname}: ${String(error)}`);
    }
  }
  return result;
}

async function copyRegularFile(sourcePath: string, targetPath: string, assertCurrent: () => void) {
  const source = await fsp.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const identity = await source.stat();
    assertCurrent();
    const target = await fsp.open(targetPath, "wx+", 0o600);
    try {
      await copyFileHandle(source, target);
      if (
        (await target.stat()).size !== identity.size ||
        hashFileDescriptorSync(source.fd).sha256 !== hashFileDescriptorSync(target.fd).sha256
      ) {
        throw new Error(`SQLite NOCOW copy mismatch: ${sourcePath}`);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

function runAclTool(command: "getfacl" | "setfacl", args: string[], input?: string): string {
  // POSIX mode suppresses default ACLs and disables the required setfacl options.
  const env = { ...process.env };
  delete env.POSIXLY_CORRECT;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: TOOL_TIMEOUT_MS,
    input,
    env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`NOCOW repair requires working ${command} to preserve access and default ACLs`);
  }
  return result.stdout.trim();
}

function readAcls(paths: string[]): string[] {
  const acls = runAclTool("getfacl", ["-cEpn", "--", ...paths]).split(/\n\s*\n/u);
  if (acls.length !== paths.length) {
    throw new Error("NOCOW repair could not read all source ACLs");
  }
  return acls;
}

function preserveMetadata(targets: string[], originals: fs.BigIntStats[], acls: string[]) {
  for (const [index, target] of targets.entries()) {
    const original = originals[index]!;
    const current = fs.statSync(target);
    if (BigInt(current.uid) !== original.uid || BigInt(current.gid) !== original.gid) {
      fs.chownSync(target, Number(original.uid), Number(original.gid));
    }
    // Keep inherited named grants masked until the complete source ACL is installed.
    fs.chmodSync(target, Number(original.mode) & 0o7700);
  }
  const restore = targets
    .map((target, index) => {
      const escaped = target.replaceAll("\\", "\\134").replaceAll("\n", "\\012");
      return `# file: ${escaped}\n${acls[index]}\n`;
    })
    .join("\n");
  runAclTool("setfacl", ["--restore=-"], restore);
  const copiedAcls = readAcls(targets);
  for (const [index, target] of targets.entries()) {
    fs.chmodSync(target, Number(originals[index]!.mode) & 0o7777);
    if (
      copiedAcls[index] !== acls[index] ||
      (fs.statSync(target).mode & 0o7777) !== (Number(originals[index]!.mode) & 0o7777)
    ) {
      throw new Error(`NOCOW copy ACL verification failed: ${target}`);
    }
    const descriptor = fs.openSync(target, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
}

const identitySchema = z.object({
  dev: z.string().regex(/^\d+$/u),
  ino: z.string().regex(/^\d+$/u),
});
const markerSchema = z.object({
  owner: z.literal("openclaw-sqlite-nocow-v1"),
  directory: z.string(),
  staging: identitySchema,
  files: z.array(
    identitySchema.extend({
      name: z
        .string()
        .min(1)
        .refine((name) => name !== "." && name !== ".." && path.basename(name) === name),
    }),
  ),
});
const MARKER = "nocow-repair.json";
const SIDECARS = ["", "-wal", "-shm", "-journal"];

function fileIdentity(stat: fs.BigIntStats) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function matches(stat: fs.BigIntStats, expected: { dev: string; ino: string }) {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino;
}

function listRepairStaging(directory: string) {
  const prefix = `${path.basename(directory)}.nocow-backup-`;
  return fs.readdirSync(path.dirname(directory), { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      return [];
    }
    const staging = path.join(path.dirname(directory), entry.name);
    try {
      const marker = markerSchema.parse(
        JSON.parse(fs.readFileSync(path.join(staging, MARKER), "utf8")),
      );
      const stat = fs.lstatSync(staging, { bigint: true });
      return marker.directory === directory && matches(stat, marker.staging)
        ? [{ staging, stat, marker }]
        : [];
    } catch {
      return []; // Old or unknown backups are never ours to delete.
    }
  });
}

function hasInterruptedRepair(directory: string) {
  return listRepairStaging(directory).some(({ staging, marker }) => {
    const existing = marker.files.filter((file) => fs.existsSync(path.join(staging, file.name)));
    return (
      existing.length === 0 ||
      existing.some(
        (file) => !matches(fs.lstatSync(path.join(staging, file.name), { bigint: true }), file),
      )
    );
  });
}

/** Only our marked staging is disposable; exchanged originals remain recovery artifacts. */
async function cleanInterruptedRepair(directory: string, assertCurrent: () => void) {
  for (const { staging, stat, marker } of listRepairStaging(directory)) {
    let retained = false;
    for (const file of marker.files) {
      const target = path.join(staging, file.name);
      if (!fs.existsSync(target)) {
        continue;
      }
      if (matches(fs.lstatSync(target, { bigint: true }), file)) {
        retained = true;
        continue;
      }
      // These are uninstalled copies in our owned directory, even if SQLite
      // checkpointed and removed the corresponding live sidecars after restart.
      assertCurrent();
      fs.unlinkSync(target);
    }
    if (!retained) {
      await removeUninstalledDirectory(staging, stat, assertCurrent);
    }
  }
}

async function removeUninstalledDirectory(
  pathname: string,
  identity: fs.BigIntStats,
  assertCurrent: () => void,
) {
  const parent = await fsSafeRoot(path.dirname(pathname));
  await parent.remove(path.basename(pathname), {
    recursive: true,
    assertBeforeMutation() {
      assertCurrent();
      const current = fs.lstatSync(pathname, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error(`NOCOW staging identity changed: ${pathname}`);
      }
    },
  });
}

function assertNoOpenFiles(paths: readonly string[]) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchBytes = 0;
  for (const pathname of paths) {
    const absolute = path.resolve(pathname);
    const bytes = Buffer.byteLength(absolute, "utf8") + 1;
    if (
      batch.length > 0 &&
      (batch.length >= FUSER_MAX_PATHS || batchBytes + bytes > FUSER_MAX_PATH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(absolute);
    batchBytes += bytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }

  const pids = new Set<string>();
  let inspectionError: string | undefined;
  for (const args of batches) {
    const result = spawnSync("fuser", args, {
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_MS,
    });
    const stdout = result.stdout?.trim() ?? "";
    const stderr = result.stderr?.trim() ?? "";
    if (result.status === 0 && /^\d+(?:\s+\d+)*$/u.test(stdout)) {
      for (const pid of stdout.split(/\s+/u)) {
        pids.add(pid);
      }
    } else if (result.error || result.status !== 1 || stdout || stderr) {
      inspectionError ??=
        stderr ||
        result.error?.message ||
        (result.signal ? `signal ${result.signal}` : stdout || `exit status ${result.status}`);
    }
  }
  if (pids.size > 0) {
    throw new Error(
      `store files are open (pids: ${[...pids].join(", ")}); stop processes using this store before retrying`,
    );
  }
  if (inspectionError) {
    throw new Error(
      `fuser could not establish that all handles are closed: ${inspectionError}; check that fuser is installed and can inspect processes using this store`,
    );
  }
}

/** Only the live Doctor maintenance owner may call this after draining its database handles. */
export async function repairDoctorSqliteNoCow(params: {
  paths: readonly string[];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
  log?: (message: string) => void;
}): Promise<MigrationMessages> {
  const preflighted = new Set<bigint>();
  const result: MigrationMessages = { changes: [], warnings: [] };
  for (const directory of new Set(
    params.paths.map((pathname) => path.dirname(path.resolve(pathname))),
  )) {
    let backup: string | undefined;
    let exchangeAttempted = false;
    let directoryAdmitted = false;
    const rewritten = new Map<string, fs.BigIntStats>();
    try {
      params.assertCurrent();
      const relative = path.relative(path.resolve(params.stateDir), directory);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("store directory must be owned by the active state directory");
      }
      assertDoctorSqliteMaintenancePathsNotAliased(
        "SQLite NOCOW repair",
        [directory],
        [params.stateDir],
      );
      directoryAdmitted = true;
      await cleanInterruptedRepair(directory, params.assertCurrent);
      const databases = [...new Set(params.paths.map((pathname) => path.resolve(pathname)))].filter(
        (pathname) => path.dirname(pathname) === directory,
      );
      const family = databases.flatMap((pathname) =>
        SIDECARS.map((suffix) => `${pathname}${suffix}`),
      );
      assertDoctorSqliteMaintenancePathsNotAliased("SQLite NOCOW repair", family, [
        params.stateDir,
      ]);
      const files = family.filter((pathname) => fs.existsSync(pathname));
      const inventory = new Map(
        files.map((pathname) => [pathname, fs.lstatSync(pathname, { bigint: true })]),
      );
      for (const [pathname, stat] of inventory) {
        if (!stat.isFile()) {
          throw new Error(`SQLite NOCOW source is not a regular file: ${pathname}`);
        }
      }
      const rewrites = files.filter((pathname) => !hasNoCow(pathname));
      if (rewrites.length === 0) {
        params.assertCurrent();
        setSqliteDirectoryNoCow(directory);
        continue;
      }
      const device = fs.statSync(directory, { bigint: true }).dev;
      if (!preflighted.has(device)) {
        const scratch = fs.mkdtempSync(`${directory}.nocow-probe-`);
        let descriptor: number | undefined;
        try {
          const [left, right] = [path.join(scratch, "a"), path.join(scratch, "b")] as const;
          fs.writeFileSync(left, "");
          fs.writeFileSync(right, "");
          descriptor = fs.openSync(left, "r");
          const options = { encoding: "utf8" as const, timeout: TOOL_TIMEOUT_MS };
          const fuser = spawnSync("fuser", [left], options);
          if (
            fuser.error ||
            fuser.status !== 0 ||
            !(fuser.stdout ?? "").split(/\s+/u).includes(String(process.pid))
          ) {
            throw new Error("fuser cannot inspect processes");
          }
          const exchange = spawnSync(
            "mv",
            ["--exchange", "--no-copy", "-T", "--", left, right],
            options,
          );
          if (exchange.error || exchange.status !== 0) {
            throw new Error("kernel/filesystem lacks RENAME_EXCHANGE or mv is unsupported");
          }
          preflighted.add(device);
        } finally {
          if (descriptor !== undefined) {
            fs.closeSync(descriptor);
          }
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
      for (const pathname of databases) {
        params.assertCurrent();
        retireSqliteDatabaseAdmissionForPath(pathname, { requireSoleDescriptor: true });
      }
      assertNoOpenFiles(files);
      const size = [...inventory.values()].reduce((total, stat) => total + stat.size, 0n);
      const space = fs.statfsSync(directory, { bigint: true });
      if (space.bavail * space.bsize < size * 2n) {
        throw new Error(
          `at least ${size * 2n} bytes of free space are required (twice the SQLite file size)`,
        );
      }
      params.log?.(`Rewriting SQLite files with NOCOW: ${directory} (0/${rewrites.length}).`);
      const acls = readAcls(rewrites);
      params.assertCurrent();
      setSqliteDirectoryNoCow(directory);
      backup = fs.mkdtempSync(`${directory}.nocow-backup-`);
      setSqliteDirectoryNoCow(backup);
      const marker = {
        owner: "openclaw-sqlite-nocow-v1",
        directory,
        staging: fileIdentity(fs.statSync(backup, { bigint: true })),
        files: rewrites.map((pathname) => ({
          name: path.basename(pathname),
          ...fileIdentity(inventory.get(pathname)!),
        })),
      };
      const markerFd = fs.openSync(path.join(backup, MARKER), "wx", 0o600);
      try {
        fs.writeFileSync(markerFd, JSON.stringify(marker));
        fs.fsyncSync(markerFd);
      } finally {
        fs.closeSync(markerFd);
      }
      const snapshots = path.join(backup, "snapshots");
      fs.mkdirSync(snapshots, { mode: 0o700 });
      for (const pathname of databases) {
        params.log?.(`Backing up SQLite store before NOCOW repair: ${pathname}.`);
        await createVerifiedSqliteSnapshot({
          sourcePath: pathname,
          targetPath: path.join(snapshots, path.basename(pathname)),
          preserveRowIds: true,
          beforePublish: params.assertCurrent,
        });
      }
      const targets = rewrites.map((pathname) => path.join(backup!, path.basename(pathname)));
      for (const [index, pathname] of rewrites.entries()) {
        params.log?.(
          `Copying SQLite file for NOCOW repair (${index + 1}/${rewrites.length}): ${pathname}.`,
        );
        await copyRegularFile(pathname, targets[index]!, params.assertCurrent);
        if (!hasNoCow(targets[index]!)) {
          throw new Error(`NOCOW was not inherited by ${targets[index]}`);
        }
      }
      params.assertCurrent();
      preserveMetadata(
        targets,
        rewrites.map((pathname) => inventory.get(pathname)!),
        acls,
      );
      requireDirectorySync(await syncDirectory(backup), "SQLite NOCOW staging directory");
      requireDirectorySync(
        await syncDirectory(path.dirname(directory)),
        "SQLite NOCOW backup parent",
      );
      // Byte-identical files keep every partially exchanged family valid, including its WAL.
      // Offline custody excludes writers; each original stays in the recovery directory.
      assertNoOpenFiles(files);
      for (const [index, pathname] of rewrites.entries()) {
        const target = targets[index]!;
        const original = inventory.get(pathname)!;
        const replacement = fs.statSync(target, { bigint: true });
        params.assertCurrent();
        exchangeAttempted = true;
        const exchange = spawnSync(
          "mv",
          ["--exchange", "--no-copy", "-T", "--", target, pathname],
          {
            encoding: "utf8",
            timeout: TOOL_TIMEOUT_MS,
          },
        );
        const installed = fs.statSync(pathname, { bigint: true });
        const retained = fs.statSync(target, { bigint: true });
        const swapped =
          matches(installed, fileIdentity(replacement)) &&
          matches(retained, fileIdentity(original));
        exchangeAttempted =
          !swapped &&
          !(
            matches(installed, fileIdentity(original)) &&
            matches(retained, fileIdentity(replacement))
          );
        if (!swapped) {
          throw new Error(
            `atomic SQLite file exchange failed: ${exchange.error?.message ?? exchange.stderr}`,
          );
        }
        rewritten.set(pathname, original);
        requireDirectorySync(await syncDirectory(directory), "SQLite NOCOW store directory");
        requireDirectorySync(await syncDirectory(backup), "SQLite NOCOW recovery directory");
        params.log?.(
          `Rewrote SQLite file with NOCOW (${index + 1}/${rewrites.length}): ${pathname}.`,
        );
      }
      result.changes.push(
        `Rewrote SQLite files with NOCOW: ${directory}. Originals and verified WAL-aware snapshots retained at ${backup}.`,
      );
    } catch (error) {
      if (exchangeAttempted) {
        throw new DoctorMaintenanceRefusalError(
          `SQLite NOCOW publication needs inspection: ${directory}; retained directory: ${backup}. ${String(error)}`,
          { kind: "data-at-risk", reason: "incomplete-migration" },
        );
      }
      try {
        if (directoryAdmitted) {
          await cleanInterruptedRepair(directory, params.assertCurrent);
        }
      } catch (cleanupError) {
        result.warnings.push(`NOCOW staging cleanup failed: ${String(cleanupError)}`);
      }
      result.warnings.push(
        `SQLite NOCOW repair skipped for ${directory}: ${String(error)}. Originals remain in place or in ${backup ?? "their original directory"}. Required: GNU mv with --exchange/--no-copy, fuser (psmisc), getfacl/setfacl (acl). See https://docs.openclaw.ai/reference/database-schemas/integrity-and-recovery#btrfs-and-nocow.`,
      );
    } finally {
      if (rewritten.size > 0) {
        try {
          result.warnings.push(
            ...reconcileNoCowRecoveryIdentities({
              env: params.env,
              previousIdentities: rewritten,
              assertCurrent: params.assertCurrent,
            }),
          );
        } catch (error) {
          result.warnings.push(`NOCOW recovery-identity reconciliation failed: ${String(error)}`);
        }
      }
    }
  }
  return result;
}
