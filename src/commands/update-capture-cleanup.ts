/** Original-state update and standalone Doctor captures in user-invoked cleanup. */
import fs from "node:fs";
import path from "node:path";
import { readRootStructuredFileSync } from "@openclaw/fs-safe/json";
import { collectStandaloneDoctorCaptures } from "../infra/doctor-capture-retention.js";
import { hasSymbolicLinkInDirectoryPath } from "../infra/session-sqlite-migration-manifest.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "../infra/update-capture-privacy-marker.js";
import { captureScopes } from "../infra/update-recovery-backup-reader.js";
import { isNeverActivatedFailedUpdate } from "../infra/update-run-activation.js";
import { getUpdateRun, listUpdateRuns } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { isUpdateRecoveryPending } from "../infra/update-run-recovery-schema.js";
import { inspectUpdateRecoveries, loadUpdateRecovery } from "../infra/update-run-recovery.js";
import { isUpdateRunVerificationConfirmed } from "../infra/update-run-verification.js";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "./backup-verify-manifest.js";
import type { RecoveryInventoryScan } from "./recovery-inventory-scan.js";
import type { RecoveryCleanupArtifact } from "./update-cleanup-types.js";

type CaptureIdentity = { dev: bigint; ino: bigint };

/** A rollback original is superseded only after a later update succeeded. */
export function readCompletedUpdateHistory(env: NodeJS.ProcessEnv) {
  try {
    const completed = listUpdateRuns({ limit: 100, succeeded: true }, { env });
    const [latest] = completed;
    const verified = completed.find(
      (run) => run.finishedAtMs !== null && isUpdateRunVerificationConfirmed(run.verification),
    );
    return {
      runs: listUpdateRuns({ limit: 100 }, { env }),
      latestCompletedStartedAt: latest && latest.finishedAtMs !== null ? latest.createdAtMs : 0,
      latestVerifiedStartedAt: verified?.createdAtMs ?? 0,
      hasPendingRecovery: inspectUpdateRecoveries({ env }).some(({ record }) =>
        isUpdateRecoveryPending(record),
      ),
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
  latestVerifiedStartedAt: number,
  env: NodeJS.ProcessEnv,
): Pick<RecoveryCleanupArtifact, "outcome" | "reason"> {
  if (run.status === "running" || run.finishedAtMs === null) {
    return { outcome: "protected", reason: "unfinished-update-run" };
  }
  const recovery = loadUpdateRecovery(run.runId, { env });
  if (recovery && isUpdateRecoveryPending(recovery)) {
    return { outcome: "protected", reason: "pending-update-recovery" };
  }
  // A failure that never activated left the original state live; its copy restores nothing.
  if (isNeverActivatedFailedUpdate(run)) {
    return { outcome: "candidate", reason: "never-activated-update-capture" };
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
  // An incomplete copy may still contain the only pre-failure bytes. A bare
  // success label without Gateway verification cannot supersede that evidence.
  if (!((sealed ? latestCompletedStartedAt : latestVerifiedStartedAt) > run.finishedAtMs)) {
    return {
      outcome: "protected",
      reason: sealed ? "awaiting-later-completed-update" : "awaiting-later-verified-update",
    };
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
  scan?: RecoveryInventoryScan;
  readHistory?: boolean;
  measureBytes?: boolean;
}) {
  const artifacts: RecoveryCleanupArtifact[] = [];
  const identities = new Map<string, CaptureIdentity>();
  const scopes = new Set([params.stateDir, ...captureScopes(params.env).keys()]);
  for (const stateDir of scopes) {
    if (params.scan && !params.scan.available()) {
      break;
    }
    const inventory = collectCaptureRootInventory({ ...params, stateDir });
    artifacts.push(...inventory.artifacts);
    for (const [directory, identity] of inventory.identities) {
      identities.set(directory, identity);
    }
  }
  return { artifacts, identities };
}

function collectCaptureRootInventory(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  scan?: RecoveryInventoryScan;
  readHistory?: boolean;
  measureBytes?: boolean;
}) {
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
  const history = params.readHistory === false ? undefined : readCompletedUpdateHistory(params.env);
  // Standalone retention reads every manifest; status first qualifies their total metadata cost.
  const rootEntries = params.scan
    ? [...params.scan.directory(root)]
    : fs.readdirSync(root, { withFileTypes: true });
  const doctorMetadataComplete =
    !params.scan ||
    rootEntries
      .filter((entry) => entry.name.startsWith("doctor-"))
      .every((entry) => params.scan!.metadata(path.join(root, entry.name, "manifest.json")));
  const standalone =
    params.readHistory === false || !doctorMetadataComplete || params.scan?.incomplete
      ? new Map<string, { eligible: boolean; reason: string }>()
      : collectStandaloneDoctorCaptures(params).captures;
  const entries = rootEntries
    .filter((entry) => entry.name !== UPDATE_CAPTURE_PRIVACY_MARKER)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (params.scan && !params.scan.available()) {
      break;
    }
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
    item.bytes =
      params.measureBytes === false
        ? 0
        : params.scan
          ? params.scan.logicalBytes(directory)
          : logicalBytes(directory);
    // The producer names each capture by run id and marks it before staging any payload.
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/u.test(entry.name) ||
      !fs
        .lstatSync(path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER), { throwIfNoEntry: false })
        ?.isFile()
    ) {
      continue;
    }
    item.captureSource = entry.name.startsWith("doctor-") ? "doctor" : "update";
    if (!history) {
      item.reason = "unreadable-update-history";
      continue;
    }
    try {
      const run =
        history.runs.find((candidate) => candidate.runId === entry.name) ??
        getUpdateRun(entry.name, { env: params.env });
      const doctor = standalone.get(directory);
      if (!run && !doctor) {
        const incomplete =
          !fs.existsSync(path.join(directory, "manifest.json")) ||
          fs.existsSync(path.join(directory, "manifest.json.partial"));
        if (incomplete) {
          item.detail =
            "No matching run; explicit retirement requires a later verified successful update and settled recovery.";
          // Missing history is not success. Explicit retirement needs a verified
          // successor newer than the capture, with no recovery still pending.
          if (
            !history.hasPendingRecovery &&
            history.latestVerifiedStartedAt > fs.lstatSync(directory).mtimeMs
          ) {
            item.reason = "superseded-unsealed-capture";
            item.detail =
              "Historical incomplete capture superseded by a later verified successful update. Retire only with an explicit --include-unmanifested path.";
          }
          continue;
        }
        // Sealed standalone originals remain under Doctor's retention policy.
        if (entry.name.startsWith("doctor-")) {
          continue;
        }
        if (params.scan && !params.scan.metadata(path.join(directory, "manifest.json"))) {
          continue;
        }
        const manifest = readRootStructuredFileSync<UpdateRecoveryBackupManifest>({
          rootDir: directory,
          relativePath: "manifest.json",
          boundaryLabel: "update capture",
          rejectHardlinks: true,
          maxBytes: 128 * 1024 * 1024,
          parse: parseUpdateRecoveryBackupManifest,
        });
        if (manifest.ok && manifest.value.runId === entry.name) {
          item.reason = "orphan-update-capture";
          item.detail = `Sealed update capture created ${manifest.value.createdAt}; no matching update run. Retire only with an explicit --include-unmanifested path.`;
        }
        continue;
      }
      item.runs = [entry.name];
      Object.assign(
        item,
        doctor
          ? { outcome: doctor.eligible ? "candidate" : "protected", reason: doctor.reason }
          : classifyCapture(
              directory,
              run!,
              history.latestCompletedStartedAt,
              history.latestVerifiedStartedAt,
              params.env,
            ),
      );
      if (item.outcome === "candidate") {
        item.detail = doctor ? "standalone Doctor capture" : `update ${run!.status}`;
        item.consequence =
          "Permanently deletes this original-state capture and any recovery generations inside it.";
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
  onProgress?: (item: RecoveryCleanupArtifact, index: number) => void;
}): Promise<void> {
  for (const [index, item] of params.selected.entries()) {
    try {
      params.onProgress?.(item, index);
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
