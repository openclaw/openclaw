/** Doctor recovers only proven duplicate files, before either owner's schema changes. */
import fs from "node:fs";
import path from "node:path";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { checkpointDoctorSqliteFile } from "../commands/doctor-sqlite-compact.js";
import { isSessionArchiveArtifactName } from "../config/sessions/artifacts.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readExistingAgentSchemaMeta } from "../state/openclaw-agent-db-schema-helpers.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  resolveImmutableSqliteFileUri,
} from "./node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { moveSqliteFilesAside, planSqliteRecoveryMoves } from "./sqlite-recovery-files.js";

type Target = { agentId: string; path: string };
type Recovery = { recovered: boolean; warning: string };

function filesEqual(left: string, right: string): boolean {
  const leftStat = fs.lstatSync(left, { bigint: true, throwIfNoEntry: false });
  const rightStat = fs.lstatSync(right, { bigint: true, throwIfNoEntry: false });
  if (!leftStat || !rightStat) {
    return !leftStat && !rightStat;
  }
  if (
    !leftStat.isFile() ||
    !rightStat.isFile() ||
    leftStat.nlink !== 1n ||
    rightStat.nlink !== 1n ||
    (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) ||
    leftStat.size !== rightStat.size
  ) {
    return false;
  }
  const leftFd = fs.openSync(left, "r");
  try {
    const rightFd = fs.openSync(right, "r");
    try {
      const a = Buffer.allocUnsafe(1024 * 1024);
      const b = Buffer.allocUnsafe(a.length);
      for (let offset = 0; offset < leftStat.size;) {
        const aRead = fs.readSync(leftFd, a, 0, a.length, offset);
        const bRead = fs.readSync(rightFd, b, 0, b.length, offset);
        if (aRead === 0 || aRead !== bRead || !a.subarray(0, aRead).equals(b.subarray(0, bRead))) {
          return false;
        }
        offset += aRead;
      }
      return (
        sameFileMutationFingerprint(leftStat, fs.fstatSync(leftFd, { bigint: true })) &&
        sameFileMutationFingerprint(rightStat, fs.fstatSync(rightFd, { bigint: true })) &&
        sameFileMutationFingerprint(leftStat, fs.lstatSync(left, { bigint: true })) &&
        sameFileMutationFingerprint(rightStat, fs.lstatSync(right, { bigint: true }))
      );
    } finally {
      fs.closeSync(rightFd);
    }
  } finally {
    fs.closeSync(leftFd);
  }
}

function archiveNames(directory: string): string[] {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) {
    return [];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Transcript archive directory is aliased or invalid: ${directory}`);
  }
  return fs
    .readdirSync(directory)
    .filter((name) => name.includes(".jsonl.") && isSessionArchiveArtifactName(name));
}

function assertEqualFileSets(copy: Target, owner: Target): void {
  const ownerFiles = resolveSqliteDatabaseFilePaths(owner.path);
  for (const [index, source] of resolveSqliteDatabaseFilePaths(copy.path).entries()) {
    if (!filesEqual(source, ownerFiles[index]!)) {
      throw new Error(`SQLite files differ or are aliased: ${source}`);
    }
  }
  const copyDirectory = resolveSqliteTranscriptArchiveDirectory(copy);
  const ownerDirectory = resolveSqliteTranscriptArchiveDirectory(owner);
  const names = new Set([...archiveNames(copyDirectory), ...archiveNames(ownerDirectory)]);
  for (const name of names) {
    if (!filesEqual(path.join(copyDirectory, name), path.join(ownerDirectory, name))) {
      throw new Error(`Transcript archive dependencies differ or are aliased: ${name}`);
    }
  }
}

function checkpoint(target: Target, maintenance: OpenClawStateLeaseContext): void {
  maintenance.assertOwned();
  const database = openNodeSqliteDatabase(
    resolveExistingSqliteFileUri(fs.realpathSync.native(target.path)),
  );
  try {
    assertOpenClawAgentDatabaseOwner(database, { agentId: target.agentId, pathname: target.path });
    assertSqliteIntegrity(database, target.path);
    maintenance.assertOwned();
    checkpointDoctorSqliteFile(database, target.path);
  } finally {
    database.close();
  }
}

function quarantineCommand(pathname: string): string {
  const moves = planSqliteRecoveryMoves(
    resolveSqliteDatabaseFilePaths(pathname).filter((file) =>
      fs.lstatSync(file, { throwIfNoEntry: false }),
    ),
  );
  // The recovery owner moves journals first and the main database last.
  moves.sort((a, b) => Number(a.sourcePath === pathname) - Number(b.sourcePath === pathname));
  return moves
    .map(({ sourcePath, destinationPath }) =>
      process.platform === "win32"
        ? `Move-Item -LiteralPath ${quotePowerShellArg(sourcePath)} -Destination ${quotePowerShellArg(destinationPath)} -ErrorAction Stop`
        : `mv -n -- ${quoteCliArg(sourcePath)} ${quoteCliArg(destinationPath)}`,
    )
    .join(process.platform === "win32" ? "; " : " && ");
}

export function recoverMisplacedAgentDatabaseCopies(params: {
  targets: readonly Target[];
  maintenance: OpenClawStateLeaseContext;
}): Map<string, Recovery> {
  const metadata = new Map<string, ReturnType<typeof readExistingAgentSchemaMeta>>();
  for (const target of params.targets) {
    try {
      // Identity discovery must not replay journals or create/change WAL read marks.
      const database = openNodeSqliteDatabase(
        resolveImmutableSqliteFileUri(fs.realpathSync.native(target.path)),
        {
          readOnly: true,
        },
      );
      try {
        metadata.set(target.path, readExistingAgentSchemaMeta(database));
      } finally {
        database.close();
      }
    } catch {
      // Normal migration reports unreadable databases; this repair needs positive identity.
    }
  }
  const results = new Map<string, Recovery>();
  for (const target of params.targets) {
    const identity = metadata.get(target.path);
    if (
      identity?.role !== "agent" ||
      !identity.agentId ||
      normalizeAgentId(identity.agentId) === target.agentId
    ) {
      continue;
    }
    const ownerId = normalizeAgentId(identity.agentId);
    const owners = params.targets.filter(
      (candidate) =>
        candidate.agentId === ownerId && metadata.get(candidate.path)?.agentId === identity.agentId,
    );
    try {
      const owner = owners.length === 1 ? owners[0] : undefined;
      if (!owner) {
        throw new Error(`Cannot identify one database for owning agent ${ownerId}`);
      }
      assertEqualFileSets(target, owner);
      checkpoint({ ...target, agentId: ownerId }, params.maintenance);
      checkpoint(owner, params.maintenance);
      assertEqualFileSets(target, owner);
      params.maintenance.assertOwned();
      const recovery = moveSqliteFilesAside(target.path, () => params.maintenance.assertOwned());
      results.set(target.path, {
        recovered: true,
        warning: `Recovered agent ${target.agentId}: ${target.path} was a byte-identical copy of agent ${ownerId}'s database. Preserved the copy at ${recovery.movedFiles.join(", ")}. Agent ${target.agentId} can start with a fresh database. Run openclaw doctor --fix to verify repairs.`,
      });
    } catch (error) {
      const action = quarantineCommand(target.path);
      results.set(target.path, {
        recovered: false,
        warning: `Refused agent ${target.agentId} database ${target.path}: belongs to agent ${ownerId}; duplicate recovery could not be verified (${String(error)}). Preserve and inspect this database before accepting a fresh agent. With all OpenClaw processes stopped, the explicit quarantine move is${process.platform === "win32" ? " (PowerShell)" : ""}:\n${action}\nThen run openclaw doctor --fix.`,
      });
    }
  }
  return results;
}
