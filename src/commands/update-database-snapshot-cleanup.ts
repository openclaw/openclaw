/** Pre-migration `.databases` snapshot directories update runs left behind, in update cleanup. */
import fs from "node:fs";
import path from "node:path";
import { resolveUserPath } from "../infra/home-dir.js";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import { readUpdateDatabaseSnapshotReceipt } from "../infra/update-database-snapshot-receipt.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { loadUpdateRecovery } from "../infra/update-run-recovery.js";
import { isGitRuntimeStagingName } from "../infra/update-runtime-staging.js";
import type { RecoveryInventoryScan } from "./recovery-inventory-scan.js";
import { logicalBytes, readCompletedUpdateHistory } from "./update-capture-cleanup.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

/** The updater's own names: beside a package backup, or a Git runtime transaction's in `.artifacts`. */
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
 * Accepted: the ledger redacts a Git checkout outside the home directory to `[path]`, so
 * its snapshots are never found here and stay where they are.
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
  for (const run of history.runs) {
    const recorded = readUpdateDatabaseSnapshotReceipt(run);
    const directory = recorded?.startsWith("~") ? resolveUserPath(recorded, params.env) : recorded;
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
    if (!fs.lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
      continue;
    }
    for (const entry of params.scan?.directory(parent) ??
      fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.isDirectory() && isSnapshotName(entry.name)) {
        directories.add(path.join(parent, entry.name));
      }
    }
  }
  for (const directory of [...directories].toSorted()) {
    if (params.scan && !params.scan.available()) {
      break;
    }
    const stat = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    // Most runs already removed theirs. An alias is not the directory the run recorded.
    if (!stat?.isDirectory() || hasSymbolicLinkInDirectoryPath(directory)) {
      continue;
    }
    const run = owners.get(directory);
    const item: RecoveryCleanupArtifact = {
      kind: "database-snapshot",
      path: directory,
      runs: run ? [run.runId] : [],
      bytes: params.scan ? params.scan.logicalBytes(directory) : logicalBytes(directory),
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
