import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { getRuntimeConfig } from "../config/config.js";
import type { BackupCreateOptions, BackupCreateResult } from "../infra/backup-create.js";
import {
  createRemoteBackupKey,
  normalizeBackupRetention,
  parseRemoteBackupTimestamp,
  resolveBackupNamespace,
  selectBackupRetention,
  type BackupRetentionOptions,
} from "../infra/backup-retention.js";
import {
  createBackupScratchDirectory,
  finishBackupScratch,
  type BackupScratch,
} from "../infra/backup-scratch.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { BackupRunLocation, BackupRunRetention } from "../state/backup-run-records.js";
import {
  openStorageLocation,
  type StorageLocation,
  type StorageLocationObjectInfo,
} from "../storage/locations.js";
import {
  assertBackupNamespaceOwner,
  claimBackupNamespace,
  listBackupNamespaces,
} from "./backup-namespace.js";

export type OffsiteBackupOptions = BackupCreateOptions &
  BackupRetentionOptions & {
    to: string;
    namespace?: string;
    claimNamespace?: boolean;
  };
export type OffsiteBackupResult = BackupCreateResult & {
  location?: BackupRunLocation;
  retention?: BackupRunRetention;
  localArchiveRetained?: boolean;
};
type RemoteBackupOptions = { from: string; namespace?: string; json?: boolean };

async function openBackupLocation(name: string, namespace?: string): Promise<StorageLocation> {
  const location = await openStorageLocation({ name, config: getRuntimeConfig() });
  try {
    const probe = await location.probe();
    if (probe.state !== "ok") {
      throw new Error(
        probe.message ??
          `Storage location ${name}: ${probe.state}. Run \`openclaw storage test ${name}\`.`,
      );
    }
    return location.scope(namespace === undefined ? "backups" : `backups/${namespace}`);
  } catch (error) {
    await location.close();
    throw error;
  }
}

async function listBackupObjects(location: StorageLocation): Promise<StorageLocationObjectInfo[]> {
  const objects = [];
  for await (const object of location.list(undefined, {
    acceptKey: (key) => parseRemoteBackupTimestamp(key) !== undefined,
  })) {
    objects.push(object);
  }
  return objects.toSorted((a, b) => b.key.localeCompare(a.key));
}

export async function createOffsiteBackupArchive(
  opts: OffsiteBackupOptions,
): Promise<OffsiteBackupResult> {
  const namespace = resolveBackupNamespace(opts.namespace);
  const retention = normalizeBackupRetention(opts);
  // Open and probe before allocating scratch or capturing any source data.
  const location = await openBackupLocation(opts.to, namespace);
  let scratch: BackupScratch | undefined;
  let output: OffsiteBackupResult | undefined;
  try {
    const { createBackupArchive } = await import("../infra/backup-create.js");
    if (opts.dryRun) {
      return await createBackupArchive(opts);
    }
    const { deviceId } = await loadOrCreateProcessDeviceIdentityAsync();
    await claimBackupNamespace(location, namespace, deviceId, opts.claimNamespace === true);
    if (!opts.output) {
      scratch = await createBackupScratchDirectory(os.tmpdir());
    }
    const result = await createBackupArchive({
      ...opts,
      output: scratch ? path.join(scratch.directory, "archive.tar.gz") : opts.output,
    });
    const { verifyBackupArchive } = await import("./backup-verify.js");
    await verifyBackupArchive(result.archivePath);
    result.verified = true;
    const plaintextBytes = (await fs.stat(result.archivePath)).size;
    const key = createRemoteBackupKey(Date.parse(result.createdAt));
    await assertBackupNamespaceOwner(location, namespace, deviceId);
    const uploaded = await location.putObject(key, createReadStream(result.archivePath), {
      sizeBytes: plaintextBytes,
      precondition: () => assertBackupNamespaceOwner(location, namespace, deviceId),
    });
    const stored = await location.stat(key);
    if (
      !stored ||
      stored.sizeBytes !== plaintextBytes ||
      stored.storedBytes !== uploaded.storedBytes
    ) {
      throw new Error(
        `Stored backup size could not be confirmed for ${opts.to}/${namespace}/${key}. Run \`openclaw storage test ${opts.to}\`.`,
      );
    }
    const description = location.describe();
    output = {
      ...result,
      archivePath: opts.output
        ? result.archivePath
        : `storage://${opts.to}/backups/${namespace}/${key}`,
      localArchiveRetained: Boolean(opts.output),
      location: {
        name: description.name,
        provider: description.provider,
        locationId: description.locationId,
        key,
        namespace,
        plaintextBytes,
        storedBytes: stored.storedBytes,
      },
    };
    if (Object.values(retention).some((value) => value !== undefined)) {
      const selected = selectBackupRetention(
        (await listBackupObjects(location)).map((object) => object.key),
        retention,
      );
      for (const expired of selected.deleted) {
        await assertBackupNamespaceOwner(location, namespace, deviceId);
        await location.delete(expired, {
          precondition: () => assertBackupNamespaceOwner(location, namespace, deviceId),
        });
      }
      output.retention = { kept: selected.kept.length, deleted: selected.deleted.length };
    }
    return output;
  } finally {
    try {
      if (scratch) {
        const warning = await finishBackupScratch(scratch, opts.log);
        if (warning && output) {
          output.warnings = [...(output.warnings ?? []), warning];
        }
      }
    } finally {
      await location.close();
    }
  }
}

export async function backupListCommand(runtime: RuntimeEnv, opts: RemoteBackupOptions) {
  const namespace = resolveBackupNamespace(opts.namespace);
  const backupsLocation = await openBackupLocation(opts.from);
  const location = backupsLocation.scope(namespace);
  try {
    const namespaces =
      opts.namespace === undefined ? await listBackupNamespaces(backupsLocation) : undefined;
    const backups = (await listBackupObjects(location)).map((object) => ({
      key: object.key,
      sizeBytes: object.sizeBytes,
      storedBytes: object.storedBytes,
      createdAt: new Date(parseRemoteBackupTimestamp(object.key)!).toISOString(),
    }));
    const result = {
      location: location.describe(),
      namespace,
      backups,
      ...(namespaces ? { namespaces } : {}),
    };
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      if (namespaces) {
        runtime.log(
          namespaces.length
            ? `Available namespaces in ${opts.from}:\n${namespaces.map((entry) => `${entry.namespace}${entry.hostname ? ` (${entry.hostname})` : ""}`).join("\n")}`
            : `No backup namespaces in ${opts.from}.`,
        );
      }
      runtime.log(
        backups.length
          ? backups
              .map(
                (backup) =>
                  `${backup.key}  ${backup.sizeBytes} bytes (${backup.storedBytes} stored)`,
              )
              .join("\n")
          : `No backups in ${opts.from}/${namespace}.`,
      );
    }
    return result;
  } finally {
    await location.close();
  }
}

async function withDownloadedBackup<T>(
  runtime: RuntimeEnv,
  opts: RemoteBackupOptions & { archive: string },
  consume: (archive: string) => Promise<T>,
): Promise<T> {
  const namespace = resolveBackupNamespace(opts.namespace);
  if (opts.archive !== "latest" && parseRemoteBackupTimestamp(opts.archive) === undefined) {
    throw new Error(
      "Expected a backup key from `openclaw backup list --from <location>` or latest.",
    );
  }
  const location = await openBackupLocation(opts.from, namespace);
  let scratch: BackupScratch | undefined;
  try {
    const key =
      opts.archive === "latest" ? (await listBackupObjects(location))[0]?.key : opts.archive;
    if (!key) {
      throw new Error(`No backups in ${opts.from}/${namespace}.`);
    }
    const body = await location.getObject(key);
    if (!body) {
      throw new Error(`Backup ${key} was not found in ${opts.from}/${namespace}.`);
    }
    scratch = await createBackupScratchDirectory(os.tmpdir());
    const archive = path.join(scratch.directory, "archive.tar.gz");
    await pipeline(body, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    return await consume(archive);
  } finally {
    try {
      if (scratch) {
        await finishBackupScratch(scratch, (message) => runtime.error(message));
      }
    } finally {
      await location.close();
    }
  }
}

export async function backupRemoteVerifyCommand(
  runtime: RuntimeEnv,
  opts: RemoteBackupOptions & { archive: string },
) {
  return await withDownloadedBackup(runtime, opts, async (archive) => {
    const { backupVerifyCommand } = await import("./backup-verify.js");
    return await backupVerifyCommand(runtime, { archive, json: opts.json });
  });
}

export async function backupRemoteRestoreCommand(
  runtime: RuntimeEnv,
  opts: RemoteBackupOptions & { archive: string; target?: string },
) {
  return await withDownloadedBackup(runtime, opts, async (archive) => {
    const { backupRestoreCommand } = await import("./backup-restore.js");
    return await backupRestoreCommand(runtime, { archive, target: opts.target, json: opts.json });
  });
}
