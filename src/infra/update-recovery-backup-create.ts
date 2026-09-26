import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parseUpdateRecoveryBackupManifest,
  type UpdateRecoveryBackupManifest,
} from "../commands/backup-verify-manifest.js";
import { ensurePrivateSnapshotRepositoryRoot } from "../snapshot/local-repository.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { pinDirectory, requireDirectorySync, syncDirectory } from "./directory-durability.js";
import { copyFileHandle, sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";
import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";
import type { UpdateRecoveryBackupRef } from "./update-recovery-backup-contract.js";
import {
  backupStore,
  digest,
  fileDigest,
  MAX_MANIFEST_BYTES,
} from "./update-recovery-backup-files.js";
import {
  inspectUpdateRecoveryBackup,
  type UpdateRecoveryCaptureParams as CaptureParams,
} from "./update-recovery-backup-inventory.js";
import { writeUpdateRecoveryPrivacyMarker } from "./update-recovery-backup-privacy.js";
import {
  captureInspectedUpdateRecoverySourcePublication,
  bindUpdateRecoverySourcePublication,
  updateRecoveryInspectedSourceResources,
} from "./update-recovery-source-publication.js";
import { captureUpdateRecoverySourceSnapshot } from "./update-recovery-source-snapshot.js";

export async function captureUpdateRecoveryBackup(
  input: CaptureParams,
): Promise<UpdateRecoveryBackupRef> {
  const params = bindUpdateRecoverySourcePublication(input);
  // Discovery readers share only this pass's private bytes. Reinspection below
  // opens a fresh snapshot; live ownership guards never consume this snapshot.
  const inspected = await withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(() => inspectUpdateRecoveryBackup(params)),
  );
  const { manifest, directory, stateDir, files, databaseOwners, configFiles } = inspected;
  // Capture before every preserving reader and snapshot, not merely manifest IO.
  const sourceCapture = await captureInspectedUpdateRecoverySourcePublication(params, inspected);
  params.assertOwned();
  const store = backupStore(stateDir);
  await ensurePrivateSnapshotRepositoryRoot(store);
  params.assertOwned();
  await writeUpdateRecoveryPrivacyMarker(store);
  params.assertOwned();
  await createPrivateSqliteDirectory(directory);
  params.assertOwned();
  await writeUpdateRecoveryPrivacyMarker(directory);
  requireDirectorySync(await syncDirectory(store), "Update capture root");
  const directoryPin = await pinDirectory(directory);
  try {
    await createPrivateSqliteDirectory(path.join(directory, "payload"));
    for (const { pathname, before, sqlite } of files) {
      const archivePath = `payload/${manifest.entries.length}`;
      const targetPath = path.join(directory, archivePath);
      params.assertOwned();
      await directoryPin.assertCurrent();
      if (sqlite) {
        const owner = databaseOwners.get(pathname);
        const snapshot = {
          sourcePath: pathname,
          targetPath,
          assertCurrent: params.assertOwned,
          validate:
            owner?.role === "global"
              ? (database: import("node:sqlite").DatabaseSync, label: string) =>
                  assertOpenClawStateDatabaseOwner(database, { pathname: label })
              : owner?.role === "agent"
                ? (database: import("node:sqlite").DatabaseSync, label: string) =>
                    assertOpenClawAgentDatabaseOwner(database, {
                      agentId: owner.agentId,
                      pathname: label,
                    })
                : undefined,
        };
        if (sourceCapture) {
          await sourceCapture.snapshot(snapshot);
        } else {
          await captureUpdateRecoverySourceSnapshot(snapshot);
        }
      } else {
        const source = await (
          await safeRoot(path.dirname(pathname))
        ).open(path.basename(pathname), { symlinks: "reject", hardlinks: "allow" });
        {
          await using sourceHandle = source.handle;
          await using output = await fs.open(targetPath, "wx+", 0o600);
          if (before.dev !== source.stat.dev || before.ino !== source.stat.ino) {
            throw new Error(`Update recovery input changed before backup: ${pathname}`);
          }
          const opened = await sourceHandle.stat({ bigint: true });
          await copyFileHandle(sourceHandle, output, {
            assertBeforeMutation: params.assertOwned,
          });
          if (!sameFileMutationFingerprint(opened, await sourceHandle.stat({ bigint: true }))) {
            throw new Error(`Update recovery input changed during backup: ${pathname}`);
          }
          await output.sync();
        }
        const after = await fs.lstat(pathname);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        ) {
          throw new Error(`Update recovery input changed during backup: ${pathname}`);
        }
      }
      const content = await fileDigest(targetPath);
      manifest.entries.push({
        kind: "file",
        sourcePath: pathname,
        archivePath,
        ...content,
        sqlite,
        mode: before.mode & 0o777,
      });
    }
    // Capture is valid only for one closed generation. Re-inventory after all
    // awaited snapshots, including WAL identities, removed includes and agents.
    const current = await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(() => inspectUpdateRecoveryBackup(params)),
    );
    const identity = (entry: Stats | undefined) =>
      entry ? [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeMs, entry.ctimeMs] : null;
    const inventory = (entries: typeof files) =>
      entries
        .map((entry) => [
          entry.pathname,
          entry.sqlite,
          identity(entry.before),
          entry.sidecars.map(identity),
        ])
        .toSorted((left, right) => String(left[0]).localeCompare(String(right[0])));
    const nonFiles = (entries: UpdateRecoveryBackupManifest["entries"]) =>
      entries
        .filter((entry) => entry.kind !== "file")
        .toSorted((left, right) => left.sourcePath.localeCompare(right.sourcePath));
    const previousInputs = new Map(inventory(files).map((entry) => [String(entry[0]), entry]));
    const currentInputs = new Map(inventory(current.files).map((row) => [String(row[0]), row]));
    const changedInputs = [...new Set([...previousInputs.keys(), ...currentInputs.keys()])].filter(
      (pathname) =>
        JSON.stringify(previousInputs.get(pathname)) !==
        JSON.stringify(currentInputs.get(pathname)),
    );
    if (
      changedInputs.length > 0 ||
      JSON.stringify(nonFiles(manifest.entries)) !==
        JSON.stringify(nonFiles(current.manifest.entries)) ||
      JSON.stringify([...configFiles].toSorted()) !==
        JSON.stringify([...current.configFiles].toSorted()) ||
      JSON.stringify([...databaseOwners].toSorted(([a], [b]) => a.localeCompare(b))) !==
        JSON.stringify([...current.databaseOwners].toSorted(([a], [b]) => a.localeCompare(b)))
    ) {
      throw new Error(
        `Update recovery resource closure or physical input changed during capture; no replacement is permitted. Changed inputs: ${changedInputs.slice(0, 5).join(", ") || "directory/config/database inventory"}.`,
      );
    }
    await sourceCapture?.assertUnchanged(updateRecoveryInspectedSourceResources(current));
    params.assertOwned();
    manifest.configPaths = [...configFiles].toSorted();
    manifest.databases = [...databaseOwners].map(([pathname, owner]) =>
      owner.role === "global"
        ? { path: pathname, role: "global" }
        : { path: pathname, role: "agent", agentId: owner.agentId },
    );
    const raw = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) {
      throw new Error("Update recovery inventory exceeds its manifest size bound.");
    }
    parseUpdateRecoveryBackupManifest(raw);
    const manifestPath = path.join(directory, "manifest.json");
    params.assertOwned();
    await directoryPin.assertCurrent();
    const output = await fs.open(manifestPath, "wx", 0o600);
    try {
      await output.writeFile(raw);
      await output.sync();
    } finally {
      await output.close();
    }
    requireDirectorySync(
      await syncDirectory(path.join(directory, "payload")),
      "Update recovery payload",
    );
    requireDirectorySync(await directoryPin.sync(), "Update recovery backup");
    const ref = { directory, manifestPath, manifestSha256: digest(raw) };
    if (sourceCapture) {
      const attestation = await sourceCapture.seal(ref);
      params.assertOwned();
      params.sourcePublication!.onSealed(attestation);
      params.assertOwned();
    }
    return ref;
  } catch (error) {
    throw new Error(
      `Update recovery ${params.baseline ? "candidate preservation" : "backup before migrations"} failed; retained partial backup: ${directory}`,
      { cause: error },
    );
  } finally {
    await directoryPin.close();
  }
}
