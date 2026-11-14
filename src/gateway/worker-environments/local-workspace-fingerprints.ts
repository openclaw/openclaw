import type { BigIntStats } from "node:fs";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import type { LocalWorkspaceManifestRecord } from "./local-workspace-manifest-tree.js";
import { workspaceCtimeIsReusable } from "./workspace-hash-memo.js";
import { MAX_WORKSPACE_INVENTORY_ENTRIES } from "./workspace-inventory-limits.js";

const HEADER_BYTES = 45;
const FILE_BYTES = 16;
const FORMAT_VERSION = 1;
const RACY_CTIME_NS = -1n;

function filePaths(records: ReadonlyMap<string, LocalWorkspaceManifestRecord>): string[] {
  const paths: string[] = [];
  for (const { node } of records.values()) {
    if (node.type === "file") {
      paths.push(node.path);
    }
  }
  paths.sort();
  return paths;
}

/** Fingerprints belong to one scan and projection root; tree packs never carry stat facts. */
export function prepareLocalWorkspaceFingerprints(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  treeRef: string,
  blob: Uint8Array | null,
  scanStartedAtMs: number,
) {
  const storedBlob =
    blob === null || Buffer.isBuffer(blob)
      ? blob
      : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const paths = filePaths(records);
  let decoded: Buffer | undefined;
  if (blob) {
    try {
      const bytes = resolveZstdCodec().decompress(
        blob,
        HEADER_BYTES + MAX_WORKSPACE_INVENTORY_ENTRIES * FILE_BYTES,
      );
      if (
        bytes.length === HEADER_BYTES + paths.length * FILE_BYTES &&
        bytes.readUInt8(0) === FORMAT_VERSION &&
        bytes.subarray(9, 41).equals(Buffer.from(treeRef.slice("sha256:".length), "hex")) &&
        bytes.readUInt32LE(41) === paths.length
      ) {
        decoded = bytes;
      }
    } catch {
      // Fingerprints are a performance hint. Corrupt or unsupported blobs must hash all files.
    }
  }
  const offsets = new Map<string, number>();
  for (let index = 0; index < paths.length; index++) {
    offsets.set(paths[index]!, HEADER_BYTES + index * FILE_BYTES);
  }
  const device = decoded?.readBigUInt64LE(1);
  const reused = new Map<string, string>();
  const changed = new Map<string, string>();
  let allReusable = decoded !== undefined;
  let observedReusable = 0;

  return {
    reuseFile(
      this: void,
      entryPath: string,
      identity: string,
      stats: Pick<BigIntStats, "dev" | "ino" | "size" | "ctimeNs">,
    ) {
      const offset = offsets.get(entryPath);
      const previous = records.get(entryPath)?.node;
      if (!decoded || offset === undefined || previous?.type !== "file") {
        allReusable = false;
        return undefined;
      }
      if (
        stats.dev === device &&
        stats.ino === decoded.readBigUInt64LE(offset) &&
        stats.ctimeNs === decoded.readBigInt64LE(offset + 8) &&
        previous.size === Number(stats.size) &&
        workspaceCtimeIsReusable(stats.ctimeNs, scanStartedAtMs)
      ) {
        reused.set(entryPath, identity);
        return previous;
      }
      allReusable = false;
      return undefined;
    },
    observe(entryPath: string, identity: string) {
      if (reused.get(entryPath) === identity) {
        observedReusable++;
      } else {
        // A hashed read can report a newer identity than its initial lstat.
        allReusable = false;
        reused.delete(entryPath);
        changed.set(entryPath, identity);
      }
    },
    encode(
      currentRecords: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
      currentTreeRef: string,
    ) {
      // Every file matched its exact non-racy slot; the stored blob is already the publication.
      if (currentTreeRef === treeRef && allReusable && observedReusable === paths.length) {
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
      let dev: bigint | undefined;
      for (let index = 0; index < currentPaths.length; index++) {
        const entryPath = currentPaths[index]!;
        const targetOffset = HEADER_BYTES + index * FILE_BYTES;
        if (reused.has(entryPath)) {
          const offset = offsets.get(entryPath)!;
          dev ??= device;
          if (dev !== device) {
            return null;
          }
          decoded!.copy(bytes, targetOffset, offset, offset + FILE_BYTES);
          continue;
        }
        const identity = changed.get(entryPath);
        if (!identity) {
          return null;
        }
        const fields = identity.split(":");
        const statDev = BigInt(fields[1]!);
        dev ??= statDev;
        // One header cannot describe files spanning devices. Those scans stay correct by hashing.
        if (statDev !== dev) {
          return null;
        }
        const ctimeNs = BigInt(fields[5]!);
        bytes.writeBigUInt64LE(BigInt(fields[2]!), targetOffset);
        bytes.writeBigInt64LE(
          workspaceCtimeIsReusable(ctimeNs, scanStartedAtMs) ? ctimeNs : RACY_CTIME_NS,
          targetOffset + 8,
        );
      }
      bytes.writeBigUInt64LE(dev ?? 0n, 1);
      return resolveZstdCodec().compress(bytes);
    },
  };
}
