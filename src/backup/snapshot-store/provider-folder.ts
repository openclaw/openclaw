import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedSnapshotStoreConfig } from "./config.js";
import type { BackupSnapshotEnvelope, BackupSnapshotStore } from "./types.js";

function installationRoot(targetDir: string, installationId: string): string {
  return path.join(targetDir, "snapshots", installationId);
}

function envelopePath(targetDir: string, installationId: string, snapshotId: string): string {
  return path.join(installationRoot(targetDir, installationId), `${snapshotId}.envelope.json`);
}

function payloadPath(targetDir: string, installationId: string, snapshotId: string): string {
  return path.join(installationRoot(targetDir, installationId), `${snapshotId}.payload.bin`);
}

async function writeFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, content, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
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
      await writeFileAtomic(
        payloadPath(config.targetDir, params.installationId, params.snapshotId),
        await fs.readFile(params.payloadPath),
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
      return await Promise.all(
        envelopes.map(async (entry) => await readEnvelopeFile(path.join(root, entry))),
      );
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
