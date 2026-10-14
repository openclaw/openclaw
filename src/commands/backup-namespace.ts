import os from "node:os";
import { z } from "zod";
import { parseRemoteBackupTimestamp, resolveBackupNamespace } from "../infra/backup-retention.js";
import type { StorageLocation } from "../storage/locations.js";

const OWNER_KEY = "owner.json";
const ownerSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1),
  hostname: z.string().min(1),
  claimedAt: z.number().int().nonnegative(),
});
type NamespaceOwner = z.infer<typeof ownerSchema>;

async function readNamespaceOwner(location: StorageLocation): Promise<NamespaceOwner | undefined> {
  const body = await location.getObject(OWNER_KEY);
  if (!body) {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > 4096) {
      throw new Error("Backup namespace owner exceeds 4096 bytes.");
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return ownerSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new Error("Invalid backup namespace owner.json.");
  }
}

function assertOwner(
  location: StorageLocation,
  namespace: string,
  deviceId: string,
  owner: NamespaceOwner | undefined,
): void {
  const name = location.describe().name;
  if (!owner) {
    throw new Error(
      `Backup namespace "${namespace}" in ${name} lost its ownership claim. Retry the backup.`,
    );
  }
  if (owner.deviceId !== deviceId) {
    throw new Error(
      `Backup namespace "${namespace}" in ${name} belongs to another OpenClaw installation (${owner.hostname}, device ${owner.deviceId.slice(0, 12)}). Pass --namespace <name> to use a separate namespace, or --claim-namespace to take it over deliberately (for example after moving to new hardware).`,
    );
  }
}

export async function claimBackupNamespace(
  location: StorageLocation,
  namespace: string,
  deviceId: string,
  takeover: boolean,
): Promise<void> {
  if (takeover) {
    // Explicit takeover must also work when the old claim cannot be decoded.
    await location.delete(OWNER_KEY);
  }
  let owner = await readNamespaceOwner(location);
  if (!owner) {
    const bytes = Buffer.from(
      JSON.stringify({ version: 1, deviceId, hostname: os.hostname(), claimedAt: Date.now() }),
    );
    try {
      await location.putObject(
        OWNER_KEY,
        (async function* () {
          yield bytes;
        })(),
        { sizeBytes: bytes.length },
      );
    } catch (error) {
      // A concurrent claimant may have won the no-overwrite publication.
      owner = await readNamespaceOwner(location);
      if (!owner) {
        throw error;
      }
    }
    owner ??= await readNamespaceOwner(location);
  }
  assertOwner(location, namespace, deviceId, owner);
}

export async function assertBackupNamespaceOwner(
  location: StorageLocation,
  namespace: string,
  deviceId: string,
): Promise<void> {
  assertOwner(location, namespace, deviceId, await readNamespaceOwner(location));
}

/** Discovery is read-only and incomplete claim metadata must never prevent recovery. */
export async function listBackupNamespaces(
  backups: StorageLocation,
): Promise<Array<{ namespace: string; hostname?: string }>> {
  const namespaces = new Set<string>();
  for await (const object of backups.list(undefined, {
    acceptKey: (key) => {
      const [namespace, file, extra] = key.split("/");
      if (
        !namespace ||
        !file ||
        extra !== undefined ||
        (file !== OWNER_KEY && parseRemoteBackupTimestamp(file) === undefined)
      ) {
        return false;
      }
      try {
        resolveBackupNamespace(namespace);
      } catch {
        return false;
      }
      // Discover claims by key even if their encrypted contents or size are damaged.
      namespaces.add(namespace);
      return file !== OWNER_KEY;
    },
  })) {
    namespaces.add(object.key.slice(0, object.key.indexOf("/")));
  }
  const result: Array<{ namespace: string; hostname?: string }> = [];
  for (const namespace of [...namespaces].toSorted()) {
    const owner = await readNamespaceOwner(backups.scope(namespace)).catch(() => undefined);
    result.push({ namespace, ...(owner ? { hostname: owner.hostname } : {}) });
  }
  return result;
}
