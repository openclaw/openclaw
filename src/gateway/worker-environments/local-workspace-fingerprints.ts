import type { BigIntStats } from "node:fs";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import type { LocalWorkspaceManifestRecord } from "./local-workspace-manifest-tree.js";
import type { LocalWorkspaceCapture } from "./local-workspace-store.types.js";
import { workspaceCtimeIsReusable } from "./workspace-hash-memo.js";
import { MAX_WORKSPACE_INVENTORY_ENTRIES } from "./workspace-inventory-limits.js";

const HEADER_BYTES = 45;
const FILE_BYTES = 16;
const FORMAT_VERSION = 1;
const RACY_CTIME_NS = -1n;

type FileRecords = ReadonlyMap<string, Pick<LocalWorkspaceManifestRecord, "node">>;

function filePaths(records: FileRecords): string[] {
  const paths: string[] = [];
  for (const { node } of records.values()) {
    if (node.type === "file") {
      paths.push(node.path);
    }
  }
  paths.sort();
  return paths;
}

function decodeFingerprints(blob: Uint8Array, reference: string, fileCount?: number) {
  try {
    const bytes = resolveZstdCodec().decompress(
      blob,
      HEADER_BYTES + MAX_WORKSPACE_INVENTORY_ENTRIES * FILE_BYTES,
    );
    if (
      bytes.length >= HEADER_BYTES &&
      bytes.length === HEADER_BYTES + bytes.readUInt32LE(41) * FILE_BYTES &&
      (fileCount === undefined || bytes.readUInt32LE(41) === fileCount) &&
      bytes.readUInt8(0) === FORMAT_VERSION &&
      bytes.subarray(9, 41).equals(Buffer.from(reference.slice("sha256:".length), "hex"))
    ) {
      return bytes;
    }
  } catch {
    // Fingerprints are a performance hint. Corrupt or unsupported blobs must hash all files.
  }
  return undefined;
}

/** Btrfs cloning preserves file identities; only the device and directory-only baseline change. */
export function rebindClonedWorkspaceFingerprints(
  blob: Uint8Array | null | undefined,
  manifestRef: string,
  treeRef: string,
  device: bigint,
): Buffer | null {
  const bytes = blob && decodeFingerprints(blob, manifestRef);
  if (!bytes) {
    return null;
  }
  bytes.writeBigUInt64LE(device, 1);
  Buffer.from(treeRef.slice("sha256:".length), "hex").copy(bytes, 9);
  return resolveZstdCodec().compress(bytes);
}

/** Fingerprints belong to one scan and projection root; tree packs never carry stat facts. */
export function prepareLocalWorkspaceFingerprints(
  records: FileRecords,
  treeRef: string,
  blob: Uint8Array | null,
  scanStartedAtMs: number,
  capture?: LocalWorkspaceCapture,
) {
  const sourceDevice = (dev: bigint) =>
    capture && dev === capture.snapshotDev ? capture.sourceDev : dev;
  const storedBlob =
    blob === null || Buffer.isBuffer(blob)
      ? blob
      : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const paths = filePaths(records);
  const decoded = blob ? decodeFingerprints(blob, treeRef, paths.length) : undefined;
  const offsets = new Map<string, number>();
  for (let index = 0; index < paths.length; index++) {
    offsets.set(paths[index]!, HEADER_BYTES + index * FILE_BYTES);
  }
  const device = decoded?.readBigUInt64LE(1);
  const reused = new Set<string>();
  const changed = new Map<string, { identity: string; reusable?: boolean }>();
  let allReusable = decoded !== undefined;

  return {
    reuseFile(
      this: void,
      entryPath: string,
      stats: Pick<BigIntStats, "dev" | "ino" | "size" | "ctimeNs">,
    ) {
      const offset = offsets.get(entryPath);
      const previous = records.get(entryPath)?.node;
      if (!decoded || offset === undefined || previous?.type !== "file") {
        allReusable = false;
        return undefined;
      }
      // Live non-racy stat fields must match the accepted tree's slot. Content
      // reuse never skips either traversal or the owner's pending recovery gates.
      if (
        sourceDevice(stats.dev) === device &&
        stats.ino === decoded.readBigUInt64LE(offset) &&
        stats.ctimeNs === decoded.readBigInt64LE(offset + 8) &&
        previous.size === Number(stats.size) &&
        workspaceCtimeIsReusable(stats.ctimeNs, scanStartedAtMs)
      ) {
        reused.add(entryPath);
        return previous;
      }
      allReusable = false;
      return undefined;
    },
    // A hashed read can establish eligibility after discovery's earlier timestamp.
    observe(this: void, entryPath: string, identity: string, reusable?: boolean) {
      // Reused nodes are already observed by reuseFile; only hashed reads need
      // serialized identities, which may be newer than discovery's initial stat.
      allReusable = false;
      reused.delete(entryPath);
      changed.set(entryPath, { identity, reusable });
    },
    encode(
      currentRecords: FileRecords,
      currentTreeRef: string,
      invalidatedPaths?: ReadonlySet<string>,
    ) {
      if (invalidatedPaths && !decoded) {
        return null;
      }
      // Every file matched its exact non-racy slot; the stored blob is already the publication.
      if (currentTreeRef === treeRef && allReusable && reused.size === paths.length) {
        return storedBlob;
      }
      let currentPaths = paths;
      if (currentTreeRef !== treeRef) {
        const retained = paths.filter(
          (entryPath) => currentRecords.get(entryPath)?.node.type === "file",
        );
        const additions: string[] = [];
        for (const { node } of currentRecords.values()) {
          if (node.type === "file" && !offsets.has(node.path)) {
            additions.push(node.path);
          }
        }
        additions.sort();
        currentPaths = [];
        let index = 0;
        for (const entryPath of retained) {
          while (index < additions.length && additions[index]! < entryPath) {
            currentPaths.push(additions[index++]!);
          }
          currentPaths.push(entryPath);
        }
        while (index < additions.length) {
          currentPaths.push(additions[index++]!);
        }
      }
      const bytes = Buffer.alloc(HEADER_BYTES + currentPaths.length * FILE_BYTES);
      bytes.writeUInt8(FORMAT_VERSION, 0);
      Buffer.from(currentTreeRef.slice("sha256:".length), "hex").copy(bytes, 9);
      bytes.writeUInt32LE(currentPaths.length, 41);
      let dev = invalidatedPaths ? device : undefined;
      for (let index = 0; index < currentPaths.length; index++) {
        const entryPath = currentPaths[index]!;
        const targetOffset = HEADER_BYTES + index * FILE_BYTES;
        if (
          reused.has(entryPath) ||
          (invalidatedPaths && offsets.has(entryPath) && !invalidatedPaths.has(entryPath))
        ) {
          const offset = offsets.get(entryPath)!;
          dev ??= device;
          if (dev !== device) {
            return null;
          }
          decoded!.copy(bytes, targetOffset, offset, offset + FILE_BYTES);
          continue;
        }
        const observed = changed.get(entryPath);
        if (!observed) {
          if (invalidatedPaths) {
            // An applied path needs a fresh identity; unchanged target slots keep their own stats.
            bytes.writeBigInt64LE(RACY_CTIME_NS, targetOffset + 8);
            continue;
          }
          return null;
        }
        const fields = observed.identity.split(":");
        const statDev = sourceDevice(BigInt(fields[1]!));
        dev ??= statDev;
        // One header cannot describe files spanning devices. Those scans stay correct by hashing.
        if (statDev !== dev) {
          return null;
        }
        const ctimeNs = BigInt(fields[5]!);
        bytes.writeBigUInt64LE(BigInt(fields[2]!), targetOffset);
        bytes.writeBigInt64LE(
          (observed.reusable ?? workspaceCtimeIsReusable(ctimeNs, scanStartedAtMs))
            ? ctimeNs
            : RACY_CTIME_NS,
          targetOffset + 8,
        );
      }
      bytes.writeBigUInt64LE(dev ?? 0n, 1);
      return resolveZstdCodec().compress(bytes);
    },
  };
}
