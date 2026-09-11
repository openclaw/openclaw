import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import { resolveConfigPath } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { pinDirectory, requireDirectorySync } from "./directory-durability.js";
import { root as safeRoot } from "./fs-safe.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import {
  updateRecoveryTerminalOutcomeSchema,
  type UpdateRecoveryBackupRef,
  type UpdateRecoveryRetirement,
} from "./update-recovery-backup-contract.js";
import {
  backupStore,
  canonicalEntryPath,
  captureDirectory,
  digest,
  MAX_MANIFEST_BYTES,
  statOrMissing,
} from "./update-recovery-backup-files.js";

function assertLocator(runId: string, receipt: UpdateRecoveryRetirement) {
  if (
    receipt.stateDir !== resolvePathViaExistingAncestorSync(resolveStateDir()) ||
    receipt.configPath !== canonicalEntryPath(resolveConfigPath()) ||
    receipt.directory !== captureDirectory(runId, receipt.stateDir)
  ) {
    throw new Error("Update capture retirement receipt belongs to another location.");
  }
}

/** Only recorded empty-payload retirement tails are continuations; unknown captures stay untouched. */
export async function inspectUpdateRecoveryRetirements(): Promise<
  Array<{
    runId: string;
    installRoot: string;
    ref: UpdateRecoveryBackupRef;
  }>
> {
  const store = backupStore();
  if (!(await statOrMissing(store))) {
    return [];
  }
  const { getUpdateRunAsync } = await import("./update-run-reader.js");
  const result = [];
  for (const runId of await fs.readdir(store)) {
    if (runId === UPDATE_CAPTURE_PRIVACY_MARKER) {
      continue;
    }
    const capture = (await getUpdateRunAsync(runId))?.origin.updateRecoveryCapture;
    if (!capture?.retirement) {
      continue;
    }
    assertLocator(runId, capture.retirement);
    result.push({
      runId,
      installRoot: capture.retirement.installRoot,
      ref: {
        directory: capture.retirement.directory,
        manifestPath: path.join(capture.retirement.directory, "manifest.json"),
        manifestSha256: capture.manifestSha256,
      },
    });
  }
  return result;
}

/** Resume only fixed metadata after the run owner durably released every payload dependency. */
export async function resumeUpdateRecoveryRetirement(
  ref: UpdateRecoveryBackupRef,
  authority: { assertOwned: () => void },
): Promise<boolean> {
  const { getUpdateRun } = await import("./update-run-ledger.js");
  const runId = path.basename(ref.directory);
  authority.assertOwned();
  const capture = getUpdateRun(runId)?.origin.updateRecoveryCapture;
  const receipt = capture?.retirement;
  if (!receipt) {
    return false;
  }
  assertLocator(runId, receipt);
  if (
    capture.manifestSha256 !== ref.manifestSha256 ||
    ref.directory !== receipt.directory ||
    ref.manifestPath !== path.join(ref.directory, "manifest.json")
  ) {
    throw new Error("Update capture retirement identity changed.");
  }
  const assertOwned = () => {
    authority.assertOwned();
    const current = getUpdateRun(runId)?.origin.updateRecoveryCapture;
    if (
      current?.manifestSha256 !== ref.manifestSha256 ||
      !isDeepStrictEqual(current?.retirement, receipt)
    ) {
      throw new Error("Update capture retirement receipt changed.");
    }
  };
  if (!(await statOrMissing(ref.directory))) {
    return true;
  }
  await ensurePrivateSnapshotRepositoryRoot(ref.directory);
  const parent = await pinDirectory(path.dirname(ref.directory));
  const pin = await pinDirectory(ref.directory).catch(async (error: unknown) => {
    await parent.close();
    throw error;
  });
  try {
    const identity = pin.receipt.identity;
    if (
      identity.dev !== receipt.identity.dev ||
      identity.ino !== receipt.identity.ino ||
      identity.birthtimeMs !== receipt.identity.birthtimeMs
    ) {
      throw new Error("Update capture retirement directory was replaced.");
    }
    const source = await safeRoot(ref.directory);
    const names = [UPDATE_CAPTURE_PRIVACY_MARKER, "outcome.json", "manifest.json"];
    for (const entry of await source.list("", { withFileTypes: true })) {
      if (!names.includes(entry.name) || !entry.isFile || entry.isSymbolicLink) {
        throw new Error(`Update capture retirement contains unowned input: ${entry.name}`);
      }
    }
    for (const filename of names) {
      if (!(await statOrMissing(path.join(ref.directory, filename)))) {
        continue;
      }
      const raw = (
        await source.read(filename, {
          maxBytes: filename === "manifest.json" ? MAX_MANIFEST_BYTES : 16 * 1024,
          symlinks: "reject",
          hardlinks: "reject",
        })
      ).buffer;
      if (filename === "manifest.json") {
        const manifest = parseUpdateRecoveryBackupManifest(raw.toString("utf8"));
        if (
          digest(raw) !== ref.manifestSha256 ||
          manifest.runId !== runId ||
          manifest.installRoot !== receipt.installRoot ||
          manifest.stateDir !== receipt.stateDir ||
          manifest.configPath !== receipt.configPath
        ) {
          throw new Error("Update capture retirement manifest changed.");
        }
      } else if (filename === "outcome.json") {
        const outcome = updateRecoveryTerminalOutcomeSchema.parse(JSON.parse(raw.toString("utf8")));
        if (outcome.status !== receipt.outcome || outcome.manifestSha256 !== ref.manifestSha256) {
          throw new Error("Update capture retirement outcome changed.");
        }
      } else if (raw.toString("utf8") !== UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT) {
        throw new Error("Update capture privacy marker changed during retirement.");
      }
    }
    for (const filename of names) {
      await parent.assertCurrent();
      await pin.assertCurrent();
      assertOwned();
      if (await statOrMissing(path.join(ref.directory, filename))) {
        await source.remove(filename);
      }
    }
    requireDirectorySync(await pin.sync(), "Update capture retirement");
    await parent.assertCurrent();
    await pin.assertCurrent();
    assertOwned();
    await fs.rmdir(ref.directory);
    requireDirectorySync(await parent.sync(), "Update capture root retirement");
    const store = path.dirname(ref.directory);
    const storeRoot = await safeRoot(store);
    const remaining = await storeRoot.list("");
    if (remaining.length === 1 && remaining[0] === UPDATE_CAPTURE_PRIVACY_MARKER) {
      const marker = (
        await storeRoot.read(UPDATE_CAPTURE_PRIVACY_MARKER, {
          maxBytes: Buffer.byteLength(UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT),
          symlinks: "reject",
          hardlinks: "reject",
        })
      ).buffer;
      if (marker.toString("utf8") !== UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT) {
        throw new Error("Update capture root privacy marker changed.");
      }
      const ancestor = await pinDirectory(path.dirname(store));
      try {
        await parent.assertCurrent();
        await ancestor.assertCurrent();
        assertOwned();
        await storeRoot.remove(UPDATE_CAPTURE_PRIVACY_MARKER);
        requireDirectorySync(await parent.sync(), "Empty update capture root");
        await parent.assertCurrent();
        await ancestor.assertCurrent();
        assertOwned();
        await fs.rmdir(store);
        requireDirectorySync(await ancestor.sync(), "Update capture root removal");
      } finally {
        await ancestor.close();
      }
    }
    return true;
  } finally {
    await pin.close();
    await parent.close();
  }
}
