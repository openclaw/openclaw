import fs from "node:fs";
import path from "node:path";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { openRootFileSync, readFileDescriptorBoundedSync } from "./boundary-file-read.js";
import { hasErrnoCode } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { isPathInside } from "./path-guards.js";
import { hasSymbolicLinkInDirectoryPath } from "./session-sqlite-migration-manifest.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { hasPendingUpdateRecoverySeal } from "./update-recovery-capture-seal.js";
import { getUpdateRun } from "./update-run-reader.js";
import { isUpdateRecoveryPending } from "./update-run-recovery-schema.js";
import { inspectUpdateRecoveries } from "./update-run-recovery.js";

type RetentionOptions = {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  keepRunId?: string;
  now?: number;
};

/** Shared policy for automatic Doctor retention and explicit update cleanup. */
export function collectStandaloneDoctorCaptures(params: RetentionOptions) {
  const captures = new Map<string, { createdAt: number; eligible: boolean; reason: string }>();
  const warnings: string[] = [];
  const root = resolveUpdateCaptureRoot(params.stateDir);
  const options = params.env
    ? { env: params.env }
    : { path: path.join(params.stateDir, "state", "openclaw.sqlite") };
  try {
    if (hasSymbolicLinkInDirectoryPath(root)) {
      return { captures, warnings };
    }
    const names = fs.readdirSync(root);
    // Inspect the selected state's ledger even for captures beside a pre-migration root.
    // Unknown/corrupt recovery rows throw, retaining every capture rather than guessing.
    const recoveryPaths = inspectUpdateRecoveries(options)
      .filter(({ record }) => isUpdateRecoveryPending(record))
      .flatMap(({ record }) =>
        [
          record.preimages?.ref.manifestPath,
          record.checkpoint?.ref.manifestPath,
          record.checkpoint?.preimageRef?.manifestPath,
          record.restore?.planPath,
        ].concat(
          (record.afterImages ?? []).flatMap((image) => [
            image.checkpointRef.manifestPath,
            image.afterUpdate.ref.manifestPath,
            image.afterUpdate.preimageRef?.manifestPath,
          ]),
        ),
      );
    for (const name of names.toSorted()) {
      if (
        !/^doctor-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(name)
      ) {
        continue;
      }
      const directory = path.join(root, name);
      try {
        if (
          !fs.lstatSync(directory).isDirectory() ||
          hasSymbolicLinkInDirectoryPath(directory) ||
          fs.lstatSync(path.join(directory, "manifest.json.partial"), { throwIfNoEntry: false })
        ) {
          continue;
        }
        const opened = openRootFileSync({
          absolutePath: path.join(directory, "manifest.json"),
          rootPath: directory,
          boundaryLabel: "standalone Doctor capture",
          maxBytes: 128 * 1024 * 1024,
          rejectHardlinks: true,
        });
        if (!opened.ok) {
          continue;
        }
        let manifest;
        try {
          manifest = parseUpdateRecoveryBackupManifest(
            readFileDescriptorBoundedSync(opened.fd, 128 * 1024 * 1024).toString("utf8"),
          );
        } finally {
          fs.closeSync(opened.fd);
        }
        const createdAt = Date.parse(manifest.createdAt);
        if (
          manifest.runId !== name ||
          manifest.schemaVersion !== 2 ||
          manifest.generation?.kind !== "baseline" ||
          !Number.isFinite(createdAt) ||
          fs.lstatSync(path.join(directory, "outcome.json"), { throwIfNoEntry: false }) ||
          getUpdateRun(name, options) !== undefined
        ) {
          continue;
        }
        const referenced = recoveryPaths.some((ref) => ref && isPathInside(directory, ref));
        captures.set(directory, {
          createdAt,
          eligible: !referenced && name !== params.keepRunId,
          reason: referenced ? "pending-update-recovery" : "superseded-doctor-capture",
        });
      } catch (error) {
        warnings.push(
          `Standalone Doctor capture retained at ${directory}: ${formatErrorMessage(error)}`,
        );
      }
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      warnings.push(
        `Standalone Doctor capture retirement unavailable at ${root}: ${formatErrorMessage(error)}`,
      );
    }
  }
  const newest = [...captures.values()].toSorted((a, b) => b.createdAt - a.createdAt);
  for (const [index, capture] of newest.entries()) {
    const expired = (params.now ?? Date.now()) - capture.createdAt > 30 * 24 * 60 * 60_000;
    // Always preserve the newest sealed original, including after a long idle period.
    if (index === 0 || (index < 3 && !expired)) {
      capture.eligible = false;
      if (capture.reason !== "pending-update-recovery") {
        capture.reason = "retained-doctor-capture";
      }
    }
  }
  return { captures, warnings };
}

export async function retireExpiredStandaloneDoctorCaptures(
  params: RetentionOptions & { keepRunId: string; assertCurrent: () => void },
): Promise<{ retired: string[]; warnings: string[] }> {
  const { captures, warnings } = collectStandaloneDoctorCaptures(params);
  const retired: string[] = [];
  for (const [directory, { eligible }] of captures) {
    if (!eligible) {
      continue;
    }
    try {
      if (await hasPendingUpdateRecoverySeal(directory)) {
        continue;
      }
      params.assertCurrent();
      await fs.promises.rm(directory, { recursive: true });
      retired.push(directory);
    } catch (error) {
      warnings.push(
        `Standalone Doctor capture retained at ${directory}: ${formatErrorMessage(error)}`,
      );
    }
  }
  return { retired, warnings };
}
