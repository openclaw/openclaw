import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { deflateRawSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import {
  updateLocalWorkspaceManifestTree,
  type LocalWorkspaceManifestChange,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";

/** A directory's sibling treap is one immutable content-addressed pack. */
type LocalWorkspaceTreePack = {
  treeRef: string;
  /** Transport-only predecessor; the writer persists the complete resulting pack. */
  baseTreeRef?: string;
  records: LocalWorkspaceManifestRecord[];
  children: string[];
};

export type LocalWorkspacePreparation = {
  packs?: LocalWorkspaceTreePack[];
  paths?: { digest: string; compressed: Uint8Array };
};

export const LOCAL_WORKSPACE_CONTENT_BATCH = 256;

export function decodeLocalWorkspaceTree(packs: readonly string[], legacy = false) {
  const records = new Map<string, LocalWorkspaceManifestRecord>();
  for (const packed of packs) {
    const entries = legacy
      ? [JSON.parse(packed) as LocalWorkspaceManifestRecord] // SAFETY: Owner-written legacy record.
      : (JSON.parse(packed) as LocalWorkspaceManifestRecord[]); // SAFETY: Owner-written pack array.
    for (const record of entries) {
      records.set(record.node.path, record);
    }
  }
  return records;
}

export function localWorkspaceDigestBytes(ref: string): Uint8Array {
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref)) {
    throw new Error("Invalid local workspace tree digest");
  }
  return Uint8Array.from(Buffer.from(ref.slice(7), "hex"));
}

export function localWorkspaceDigestReference(bytes: Uint8Array): string {
  return `sha256:${Buffer.from(bytes).toString("hex")}`;
}

/** Advance a scan's tree and send only records absent from its persisted predecessor packs. */
export function prepareLocalWorkspaceTreeUpdate(
  records: Map<string, LocalWorkspaceManifestRecord>,
  changes: readonly LocalWorkspaceManifestChange[],
  paths: Iterable<string>,
  previousTreeRoot: string | null,
): Uint8Array[] {
  const basePacks = new Map<string | null, string>();
  if (previousTreeRoot) {
    // The accepted root retains these immutable packs through checkpoint acceptance.
    basePacks.set(null, previousTreeRoot);
    for (const entryPath of ["", ...paths]) {
      const children = records.get(entryPath)?.children;
      if (children != null) {
        basePacks.set(entryPath, records.get(children)!.treeRef);
      }
    }
  }
  const delta = updateLocalWorkspaceManifestTree(records, changes);
  return records.get("")!.treeRef === previousTreeRoot
    ? []
    : prepareLocalWorkspaceTreePacks(
        records,
        previousTreeRoot
          ? [...delta.records.map(({ node }) => node.path), ...delta.removed]
          : undefined,
        undefined,
        basePacks,
      );
}

function encodeLocalWorkspaceTreePacks(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  selectedPaths?: Iterable<string>,
  knownPacks?: ReadonlySet<string>,
  basePacks?: ReadonlyMap<string | null, string>,
): LocalWorkspaceTreePack[] {
  const selected = selectedPaths && new Set(selectedPaths);
  const roots = new Set<string>([""]);
  if (selected === undefined) {
    for (const record of records.values()) {
      if (record.children !== null) {
        roots.add(record.children);
      }
    }
  } else {
    // Removed records can promote an unchanged child to the containing pack root.
    for (const entryPath of selected) {
      if (entryPath === "") {
        continue;
      }
      const parent = entryPath.slice(0, Math.max(0, entryPath.lastIndexOf("/")));
      // Descendant deletions can also remove their containing directory.
      const children = records.get(parent)?.children;
      if (children != null) {
        roots.add(children);
      }
    }
  }
  const packs: LocalWorkspaceTreePack[] = [];
  for (const entryPath of roots) {
    const root = records.get(entryPath)!;
    if (knownPacks?.has(root.treeRef)) {
      continue;
    }
    const parent =
      entryPath === "" ? null : entryPath.slice(0, Math.max(0, entryPath.lastIndexOf("/")));
    const baseTreeRef = selected && basePacks?.get(parent);
    const packed: LocalWorkspaceManifestRecord[] = [];
    const children: string[] = [];
    const pending = [root];
    while (pending.length) {
      const record = pending.pop()!;
      if (!baseTreeRef || record === root || selected!.has(record.node.path)) {
        packed.push(record);
        if (record.children !== null) {
          children.push(records.get(record.children)!.treeRef);
        }
      }
      for (const path of [record.left, record.right]) {
        if (path !== null) {
          pending.push(records.get(path)!);
        }
      }
    }
    packs.push({ treeRef: root.treeRef, baseTreeRef, records: packed, children });
  }
  return packs;
}

export function prepareLocalWorkspaceTreePacks(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  selectedPaths?: Iterable<string>,
  knownPacks?: ReadonlySet<string>,
  basePacks?: ReadonlyMap<string | null, string>,
): Uint8Array[] {
  const packs = encodeLocalWorkspaceTreePacks(records, selectedPaths, knownPacks, basePacks);
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
