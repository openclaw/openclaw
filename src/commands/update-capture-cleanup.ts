/** Original-state update captures in user-invoked cleanup. Only the update run ledger attributes a capture. */
import fs from "node:fs";
import path from "node:path";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "../infra/update-capture-privacy-marker.js";
import { captureScopes } from "../infra/update-recovery-backup-reader.js";
import { getUpdateRun, listUpdateRuns } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { loadUpdateRecovery } from "../infra/update-run-recovery.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

type CaptureIdentity = { dev: bigint; ino: bigint };

/** A rollback original is superseded only after a later update succeeded. */
export function readCompletedUpdateHistory(env: NodeJS.ProcessEnv) {
  try {
    const [latest] = listUpdateRuns({ limit: 1, succeeded: true }, { env });
    return {
      runs: listUpdateRuns({ limit: 100 }, { env }),
      latestCompletedStartedAt: latest && latest.finishedAtMs !== null ? latest.createdAtMs : 0,
    };
  } catch {
    // Missing/unreadable update history cannot release rollback originals.
    return undefined;
  }
}

function logicalBytes(directory: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    bytes += entry.isDirectory() ? logicalBytes(entryPath) : fs.lstatSync(entryPath).size;
  }
  return bytes;
}

function classifyCapture(
  directory: string,
  run: UpdateRunRecord,
  latestCompletedStartedAt: number,
  env: NodeJS.ProcessEnv,
): Pick<RecoveryCleanupArtifact, "outcome" | "reason"> {
  if (run.status === "running" || run.finishedAtMs === null) {
    return { outcome: "protected", reason: "unfinished-update-run" };
  }
  const recovery = loadUpdateRecovery(run.runId, { env });
  if (recovery && isUpdateRecoveryPending(recovery)) {
    return { outcome: "protected", reason: "pending-update-recovery" };
  }
  const sealed =
    fs.existsSync(path.join(directory, "manifest.json")) &&
    !fs.existsSync(path.join(directory, "manifest.json.partial"));
  const capture = run.origin.updateRecoveryCapture;
  // A sealed baseline from a failed update is its manual recovery source until resolved.
  // Succeeded and skipped (already-current) runs completed without needing it.
  if (
    sealed &&
    (run.status === "failed" || run.status === "rolled-back") &&
    !capture?.restored &&
    !capture?.forwardResolution &&
    !capture?.retirement
  ) {
    return { outcome: "protected", reason: "unresolved-failed-update" };
  }
  if (!(latestCompletedStartedAt > run.finishedAtMs)) {
    return { outcome: "protected", reason: "awaiting-later-completed-update" };
  }
  return {
    outcome: "candidate",
    reason: sealed ? "superseded-update-capture" : "unsealed-update-capture",
  };
}

/** Lists every selected capture scope, including originals retained before state relocation. */
export function collectUpdateCaptureInventory(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
}) {
  const artifacts: RecoveryCleanupArtifact[] = [];
  const identities = new Map<string, CaptureIdentity>();
  const scopes = new Set([params.stateDir, ...captureScopes(params.env).keys()]);
  for (const stateDir of scopes) {
    const inventory = collectCaptureRootInventory({ stateDir, env: params.env });
    artifacts.push(...inventory.artifacts);
    for (const [directory, identity] of inventory.identities) {
      identities.set(directory, identity);
    }
  }
  return { artifacts, identities };
}

function collectCaptureRootInventory(params: { stateDir: string; env: NodeJS.ProcessEnv }) {
  const root = resolveUpdateCaptureRoot(params.stateDir);
  const artifacts: RecoveryCleanupArtifact[] = [];
  const identities = new Map<string, CaptureIdentity>();
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) {
    return { artifacts, identities };
  }
  if (!rootStat.isDirectory() || hasSymbolicLinkInDirectoryPath(root)) {
    artifacts.push({
      kind: "update-capture",
      path: root,
      runs: [],
      bytes: 0,
      outcome: "blocked",
      reason: "capture-directory-alias",
    });
    return { artifacts, identities };
  }
  const history = readCompletedUpdateHistory(params.env);
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name !== UPDATE_CAPTURE_PRIVACY_MARKER)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    const item: RecoveryCleanupArtifact = {
      kind: "update-capture",
      path: directory,
      runs: [],
      bytes: 0,
      outcome: "protected",
      reason: "unmanifested-update-capture",
    };
    artifacts.push(item);
    if (!entry.isDirectory()) {
      item.bytes = entry.isFile() ? fs.lstatSync(directory).size : 0;
      continue;
    }
    item.bytes = logicalBytes(directory);
    // The producer names each capture by run id and marks it before staging any payload.
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(entry.name) ||
      !fs
        .lstatSync(path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER), { throwIfNoEntry: false })
        ?.isFile()
    ) {
      continue;
    }
    if (!history) {
      item.reason = "unreadable-update-history";
      continue;
    }
    try {
      const run =
        history.runs.find((candidate) => candidate.runId === entry.name) ??
        getUpdateRun(entry.name, { env: params.env });
      if (!run) {
        continue;
      }
      item.runs = [run.runId];
      Object.assign(
        item,
        classifyCapture(directory, run, history.latestCompletedStartedAt, params.env),
      );
      if (item.outcome === "candidate") {
        item.detail = `update ${run.status}`;
        item.consequence =
          "Permanently deletes this update's original-state capture and any recovery generations inside it.";
        const stat = fs.lstatSync(directory, { bigint: true });
        identities.set(directory, { dev: stat.dev, ino: stat.ino });
      }
    } catch (error) {
      Object.assign(item, {
        outcome: "protected",
        reason: "unreadable-update-history",
        detail: String(error),
      });
    }
  }
  return { artifacts, identities };
}

/** Caller holds the cleanup maintenance lock and passes identities from the confirmed selection. */
export async function retireUpdateCaptures(params: {
  selected: RecoveryCleanupArtifact[];
  identities: ReadonlyMap<string, CaptureIdentity>;
  assertCurrent: () => void;
}): Promise<void> {
  for (const item of params.selected) {
    try {
      params.assertCurrent();
      const expected = params.identities.get(item.path);
      const current = fs.lstatSync(item.path, { bigint: true });
      if (
        !expected ||
        hasSymbolicLinkInDirectoryPath(item.path) ||
        !current.isDirectory() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino
      ) {
        throw new Error("update capture changed after selection");
      }
      // The marker goes last: an interrupted removal stays attributed, so a rerun finishes it.
      for (const name of fs.readdirSync(item.path)) {
        if (name !== UPDATE_CAPTURE_PRIVACY_MARKER) {
          params.assertCurrent();
          await fs.promises.rm(path.join(item.path, name), { recursive: true });
        }
      }
      params.assertCurrent();
      await fs.promises.rm(item.path, { recursive: true });
      item.outcome = "removed";
      item.removedBytes = item.bytes;
      item.reason = "update-capture-retired";
    } catch (error) {
      item.outcome = "failed";
      item.reason = "update-capture-retirement-failed";
      item.detail = String(error);
    }
  }
}
