/** Pre-migration `.databases` snapshot directories update runs left behind, in update cleanup. */
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRequiredHomeDir, resolveUserPath } from "../infra/home-dir.js";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import { readUpdateDatabaseSnapshotReceipt } from "../infra/update-database-snapshot-receipt.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { loadUpdateRecovery } from "../infra/update-run-recovery.js";
import { isGitRuntimeStagingName } from "../infra/update-runtime-staging.js";
import type { RecoveryInventoryScan } from "./recovery-inventory-scan.js";
import { logicalBytes, readCompletedUpdateHistory } from "./update-capture-cleanup.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

/**
 * The updater's own names: beside a package backup, or in a Git checkout's `.artifacts`,
 * where updaters that rebuilt the checkout in place kept theirs.
 */
function isSnapshotName(name: string): boolean {
  return (
    /^\.openclaw\.package-backup-\d+-\d+\.databases$/u.test(name) ||
    (name.endsWith(".databases") && isGitRuntimeStagingName(name.slice(0, -".databases".length)))
  );
}

/**
 * A snapshot's name carries a transaction id, not its run id, and nothing inside it names a
 * run: the run ledger's snapshot receipt is the only attribution, and it records the
 * physical directory. So discovery starts from the ledger, never from a guessed install
 * root, and reaches a previous install root only through a run that recorded it.
 * Accepted: the ledger redacts an install root outside the home directory to `[path]`, so
 * snapshots an in-place Git update left in such a checkout are never found here and stay.
 *
 * A later verified successful update supersedes a finished run's snapshot. A run's own
 * success does not: the updater keeps the snapshots it could not restore automatically.
 */
export function collectUpdateDatabaseSnapshots(params: {
  env: NodeJS.ProcessEnv;
  scan?: RecoveryInventoryScan;
  readHistory?: boolean;
}) {
  const artifacts: RecoveryCleanupArtifact[] = [];
  const identities = new Map<string, { dev: bigint; ino: bigint }>();
  const history = params.readHistory === false ? undefined : readCompletedUpdateHistory(params.env);
  if (!history) {
    return { artifacts, identities };
  }
  // Runs are listed newest first; a reused package-backup name belongs to its latest run.
  const owners = new Map<string, UpdateRunRecord>();
  // The ledger writes `~` for the OpenClaw home and the OS home alike; when they
  // differ a home-relative receipt names two directories, so it attributes none.
  const homes = new Set(
    [resolveRequiredHomeDir(params.env), params.env.HOME, params.env.USERPROFILE].flatMap((home) =>
      home ? [path.resolve(home)] : [],
    ),
  );
  for (const run of history.runs) {
    const recorded = readUpdateDatabaseSnapshotReceipt(run);
    const directory = !recorded?.startsWith("~")
      ? recorded
      : homes.size === 1
        ? resolveUserPath(recorded, params.env)
        : undefined;
    if (
      directory &&
      path.isAbsolute(directory) &&
      isSnapshotName(path.basename(directory)) &&
      !owners.has(directory)
    ) {
      owners.set(directory, run);
    }
  }
  // Snapshots beside a recorded one, from runs the ledger no longer lists, are reported too.
  const directories = new Set(owners.keys());
  for (const parent of new Set([...owners.keys()].map((directory) => path.dirname(directory)))) {
    try {
      if (!fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
        continue;
      }
      for (const entry of params.scan?.directory(parent) ??
        fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && isSnapshotName(entry.name)) {
          directories.add(path.join(parent, entry.name));
        }
      }
    } catch {
      // An unreadable or replaced earlier install root still lists the snapshots its runs recorded.
    }
  }
  for (const directory of [...directories].toSorted()) {
    if (params.scan && !params.scan.available()) {
      break;
    }
    let stat: fs.BigIntStats | undefined;
    let bytes: number;
    try {
      stat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
      // Most runs already removed theirs. An alias is not the directory the run recorded.
      if (!stat?.isDirectory() || hasSymbolicLinkInDirectoryPath(directory)) {
        continue;
      }
      bytes = params.scan ? params.scan.logicalBytes(directory) : logicalBytes(directory);
    } catch {
      // An unreadable location must not hide the other artifacts cleanup can retire.
      continue;
    }
    const run = owners.get(directory);
    const item: RecoveryCleanupArtifact = {
      kind: "database-snapshot",
      path: directory,
      runs: run ? [run.runId] : [],
      bytes,
      outcome: "protected",
      reason: "orphan-database-snapshot",
    };
    artifacts.push(item);
    if (!run) {
      // Only file times could order it against a verified update, so it stays.
      item.detail = "No listed update run recorded this snapshot directory.";
      continue;
    }
    if (run.status === "running" || run.finishedAtMs === null) {
      item.reason = "unfinished-update-run";
      continue;
    }
    try {
      const recovery = loadUpdateRecovery(run.runId, { env: params.env });
      if (recovery && isUpdateRecoveryPending(recovery)) {
        item.reason = "pending-update-recovery";
      } else if (
        history.latestVerifiedSuccessStartedAt > run.createdAtMs &&
        history.latestVerifiedSuccessStartedAt >= run.finishedAtMs
      ) {
        Object.assign(item, {
          outcome: "candidate",
          reason: "superseded-by-verified-update",
          detail: `update ${run.status}`,
          consequence:
            "Permanently deletes the pre-migration database copies this update kept for restoring its previous version.",
        });
        identities.set(directory, { dev: stat.dev, ino: stat.ino });
      } else {
        item.reason = "awaiting-later-verified-update";
      }
    } catch (error) {
      Object.assign(item, { reason: "unreadable-update-history", detail: String(error) });
    }
  }
  return { artifacts, identities };
}

/**
 * Drops the PostgreSQL server captures a snapshot's export manifests name, as the update
 * that owns a snapshot does before removing it. The manifests are the only record of those
 * server schemas, so a failed drop must leave the directory for a later cleanup.
 */
export async function discardDatabaseSnapshotServerCaptures(
  directory: string,
  config: OpenClawConfig,
): Promise<void> {
  const exports: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      // A PostgreSQL store's export sits beside its anchor image as `<image>.postgres` and
      // holds a manifest. Without one it is a mirrored source directory of that name, or an
      // export whose captures an interrupted removal already dropped.
      const child = path.join(current, entry.name);
      if (entry.name.endsWith(".postgres") && fs.existsSync(path.join(child, "manifest.json"))) {
        exports.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(directory);
  if (exports.length === 0) {
    return;
  }
  try {
    const { discardPostgresSchemaCaptures } = await import("../snapshot/database-backup.js");
    await discardPostgresSchemaCaptures(config, exports);
  } catch (error) {
    throw new Error(
      `PostgreSQL capture cleanup remains pending at ${directory}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}
