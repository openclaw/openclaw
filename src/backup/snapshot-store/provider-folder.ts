import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { ResolvedSnapshotStoreConfig } from "./config.js";
import { isValidInstallationId } from "./installation-id.js";
import type { BackupSnapshotEnvelope, BackupSnapshotStore } from "./types.js";

const SNAPSHOT_ID_PATTERN = /^snap_[0-9TZ-]+_[0-9a-f]{8}$/;

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
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as BackupSnapshotEnvelope;
}

export function createFolderSnapshotStore(
  config: ResolvedSnapshotStoreConfig,
): BackupSnapshotStore {
  return {
    async uploadSnapshot(params) {
      await copyFileAtomic(
        params.payloadPath,
        payloadPath(config.targetDir, params.installationId, params.snapshotId),
      );
      await writeFileAtomic(
        envelopePath(config.targetDir, params.installationId, params.snapshotId),
        `${JSON.stringify(params.envelope, null, 2)}\n`,
      );
    },

    async listSnapshots(params) {
      const root = installationRoot(config.targetDir, params.installationId);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(root);
      } catch {
        return [];
      }
      const envelopes = entries.filter((entry) => entry.endsWith(".envelope.json")).toSorted();
      const listed = await Promise.all(
        envelopes.map(async (entry) => {
          try {
            return await readEnvelopeFile(path.join(root, entry));
          } catch {
            return undefined;
          }
        }),
      );
      return listed.filter((entry): entry is BackupSnapshotEnvelope => entry !== undefined);
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
      await fs.mkdir(path.dirname(params.envelopeOutputPath), { recursive: true });
      await fs.copyFile(storedEnvelopePath, params.envelopeOutputPath);
      await fs.copyFile(storedPayloadPath, params.payloadOutputPath);
      return envelope;
    },
  };
}
