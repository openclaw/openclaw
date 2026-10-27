import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { deflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { LocalWorkspaceManifestRecord } from "./local-workspace-manifest-tree.js";

/** A directory's sibling treap is one immutable content-addressed pack. */
export type LocalWorkspaceTreePack = {
  treeRef: string;
  records: LocalWorkspaceManifestRecord[];
  children: string[];
};

export type LocalWorkspacePreparation = {
  packs?: LocalWorkspaceTreePack[];
  paths?: { digest: string; compressed: Uint8Array };
};

export const LOCAL_WORKSPACE_CONTENT_BATCH = 256;

export function localWorkspaceDigestBytes(ref: string): Uint8Array {
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref)) {
    throw new Error("Invalid local workspace tree digest");
  }
  return Uint8Array.from(Buffer.from(ref.slice(7), "hex"));
}

export function localWorkspaceDigestReference(bytes: Uint8Array): string {
  return `sha256:${Buffer.from(bytes).toString("hex")}`;
}

export function encodeLocalWorkspaceTreePacks(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  selected?: Iterable<LocalWorkspaceManifestRecord>,
): LocalWorkspaceTreePack[] {
  const roots = new Set<string>();
  if (selected === undefined) {
    roots.add("");
    for (const record of records.values()) {
      if (record.children !== null) {
        roots.add(record.children);
      }
    }
  } else {
    // Changed sibling records select their containing directory's current treap root.
    for (const { node } of selected) {
      if (node.path === "") {
        roots.add("");
        continue;
      }
      const parent = node.path.slice(0, Math.max(0, node.path.lastIndexOf("/")));
      const children = records.get(parent)!.children;
      if (children !== null) {
        roots.add(children);
      }
    }
  }
  return [...roots].map((entryPath) => {
    const root = records.get(entryPath)!;
    const packed: LocalWorkspaceManifestRecord[] = [];
    const children: string[] = [];
    const pending = [root];
    while (pending.length) {
      const record = pending.pop()!;
      packed.push(record);
      if (record.children !== null) {
        children.push(records.get(record.children)!.treeRef);
      }
      for (const path of [record.left, record.right]) {
        if (path !== null) {
          pending.push(records.get(path)!);
        }
      }
    }
    // A very large flat directory rewrites its whole pack on every edit.
    return { treeRef: root.treeRef, records: packed, children };
  });
}

export function prepareLocalWorkspaceTreePacks(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  selected?: Iterable<LocalWorkspaceManifestRecord>,
): Uint8Array[] {
  const packs = encodeLocalWorkspaceTreePacks(records, selected);
  const batches: Uint8Array[] = [];
  for (let offset = 0; offset < packs.length; offset += LOCAL_WORKSPACE_CONTENT_BATCH) {
    batches.push(
      deflateRawSync(
        serialize({ packs: packs.slice(offset, offset + LOCAL_WORKSPACE_CONTENT_BATCH) }),
      ),
    );
  }
  return batches;
}

export function prepareLocalWorkspaceSourcePathSet(raw: string) {
  // Array order is part of the admitted document; equal documents share bytes.
  const digest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return { digest, compressed: zstdCompressSync(Buffer.from(raw)) };
}

export function decodeLocalWorkspaceSourcePathSet(compressed: Uint8Array): string {
  return zstdDecompressSync(compressed).toString("utf8");
}
