import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { ResolvedSnapshotStoreConfig, ResolvedSnapshotStoreTargetConfig } from "./config.js";
import { isValidInstallationId } from "./installation-id.js";
import {
  parseBackupSnapshotEnvelope,
  type BackupSnapshotEnvelope,
  type BackupSnapshotListStore,
  type BackupSnapshotStore,
} from "./types.js";

const SNAPSHOT_ID_PATTERN = /^snap_[0-9TZ-]+_[0-9a-f]{8}$/;

/** Max envelope JSON size (1 MiB) – envelopes are tiny metadata; anything larger is suspect. */
const MAX_ENVELOPE_BYTES = 1 * 1024 * 1024;
/** Max payload size (10 GiB) – upper bound for a single encrypted snapshot payload. */
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024 * 1024;
const SNAPSHOT_LIST_READ_CONCURRENCY = 8;

/**
 * Assert that `filePath` is a regular file (not a symlink/device/etc.) and
 * does not exceed `maxBytes`.  Prevents symlink-following and unbounded reads
 * from untrusted snapshot directories.
 */
async function assertRegularFileWithinLimit(
  filePath: string,
  maxBytes: number,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds maximum allowed size (${maxBytes} bytes): ${filePath}`);
  }
}

function assertValidStorageId(kind: "installationId" | "snapshotId", value: string): void {
  const isValid =
    kind === "installationId" ? isValidInstallationId(value) : SNAPSHOT_ID_PATTERN.test(value);
  if (!isValid) {
    throw new Error(`Invalid ${kind}: ${value}`);
  }
}

function installationRoot(targetDir: string, installationId: string): string {
  assertValidStorageId("installationId", installationId);
  return path.join(targetDir, "snapshots", installationId);
}

function envelopePath(targetDir: string, installationId: string, snapshotId: string): string {
  assertValidStorageId("snapshotId", snapshotId);
  return path.join(installationRoot(targetDir, installationId), `${snapshotId}.envelope.json`);
}

function payloadPath(targetDir: string, installationId: string, snapshotId: string): string {
  assertValidStorageId("snapshotId", snapshotId);
  return path.join(installationRoot(targetDir, installationId), `${snapshotId}.payload.bin`);
}

async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
  await fs.rename(tempPath, filePath);
}

async function copyFileAtomic(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await pipeline(
      fsSync.createReadStream(sourcePath),
      fsSync.createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
    await fs.rename(tempPath, destinationPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readEnvelopeFile(filePath: string): Promise<BackupSnapshotEnvelope> {
  await assertRegularFileWithinLimit(filePath, MAX_ENVELOPE_BYTES, "Envelope file");
  const raw = await fs.readFile(filePath, "utf8");
  return parseBackupSnapshotEnvelope(raw);
}

function serializeEnvelope(envelope: BackupSnapshotEnvelope): string {
  const raw = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(raw, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error(`Envelope file exceeds maximum allowed size (${MAX_ENVELOPE_BYTES} bytes).`);
  }
  return raw;
}

async function listSnapshotsFromDir(
  targetDir: string,
  params: { installationId: string },
): Promise<BackupSnapshotEnvelope[]> {
  const root = installationRoot(targetDir, params.installationId);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const envelopes = entries.filter((entry) => entry.endsWith(".envelope.json")).toSorted();
  const { results, hasError, firstError } = await runTasksWithConcurrency({
    errorMode: "stop",
    limit: SNAPSHOT_LIST_READ_CONCURRENCY,
    tasks: envelopes.map((entry) => async () => {
      const filePath = path.join(root, entry);
      let raw: string;
      try {
        await assertRegularFileWithinLimit(filePath, MAX_ENVELOPE_BYTES, "Envelope file");
        raw = await fs.readFile(filePath, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      try {
        return parseBackupSnapshotEnvelope(raw);
      } catch {
        return undefined;
      }
    }),
  });
  if (hasError) {
    throw firstError;
  }
  return results.filter((entry): entry is BackupSnapshotEnvelope => entry !== undefined);
}

export function createFolderSnapshotStore(
  config: ResolvedSnapshotStoreConfig,
): BackupSnapshotStore {
  return {
    async uploadSnapshot(params) {
      const serializedEnvelope = serializeEnvelope(params.envelope);
      await assertRegularFileWithinLimit(params.payloadPath, MAX_PAYLOAD_BYTES, "Payload file");
      await copyFileAtomic(
        params.payloadPath,
        payloadPath(config.targetDir, params.installationId, params.snapshotId),
      );
      await writeFileAtomic(
        envelopePath(config.targetDir, params.installationId, params.snapshotId),
        serializedEnvelope,
      );
    },

    async listSnapshots(params) {
      return listSnapshotsFromDir(config.targetDir, params);
    },

    async downloadSnapshot(params) {
      const storedEnvelopePath = envelopePath(
        config.targetDir,
        params.installationId,
        params.snapshotId,
      );
      const storedPayloadPath = payloadPath(
        config.targetDir,
        params.installationId,
        params.snapshotId,
      );
      const envelope = await readEnvelopeFile(storedEnvelopePath);
      await assertRegularFileWithinLimit(storedPayloadPath, MAX_PAYLOAD_BYTES, "Payload file");
      await fs.mkdir(path.dirname(params.envelopeOutputPath), { recursive: true });
      await fs.copyFile(storedEnvelopePath, params.envelopeOutputPath);
      await fs.copyFile(storedPayloadPath, params.payloadOutputPath);
      return envelope;
    },
  };
}

/** Create a list-only store that does not require an encryption key. */
export function createFolderSnapshotListStore(
  config: ResolvedSnapshotStoreTargetConfig,
): BackupSnapshotListStore {
  return {
    async listSnapshots(params) {
      return listSnapshotsFromDir(config.targetDir, params);
    },
  };
}
