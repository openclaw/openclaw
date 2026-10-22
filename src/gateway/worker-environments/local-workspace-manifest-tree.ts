import { createHash } from "node:crypto";
import type { WorkerWorkspaceManifestEntry } from "./workspace-manifest.js";

export type LocalWorkspaceManifestNode =
  | WorkerWorkspaceManifestEntry
  | { path: string; type: "directory" };

export type LocalWorkspaceManifestRecord = {
  node: LocalWorkspaceManifestNode;
  left: string | null;
  right: string | null;
  children: string | null;
  contentRef: string;
  treeRef: string;
  canonicalIdentity?: string;
  projectionIdentity?: string;
};

export type LocalWorkspaceManifestChange = { path: string; node?: LocalWorkspaceManifestNode };

function digest(domain: string, ...values: (string | number | null)[]): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([`openclaw.local-workspace.${domain}.v1`, ...values]))
    .digest("hex")}`;
}

const EMPTY_REF = digest("empty");

function parentPath(value: string): string {
  const separator = value.lastIndexOf("/");
  return separator === -1 ? "" : value.slice(0, separator);
}

export function localWorkspaceManifestRootReference(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
  baseCommit: string | null,
): string {
  return digest("root", baseCommit, records.get("")!.treeRef);
}

export function createLocalWorkspaceManifestTree(
  nodes: readonly LocalWorkspaceManifestNode[],
): Map<string, LocalWorkspaceManifestRecord> {
  const records = new Map<string, LocalWorkspaceManifestRecord>();
  updateLocalWorkspaceManifestTree(
    records,
    nodes.map((node) => ({ path: node.path, node })),
  );
  return records;
}

/** Each directory owns a deterministic sibling treap, so a flat directory is incremental too. */
export function updateLocalWorkspaceManifestTree(
  records: Map<string, LocalWorkspaceManifestRecord>,
  changes: readonly LocalWorkspaceManifestChange[],
): { records: LocalWorkspaceManifestRecord[]; removed: string[] } {
  const touched = new Map<string, LocalWorkspaceManifestRecord>();
  const removed = new Set<string>();
  const priorities = new Map<string, string>();
  const recordAt = (entryPath: string | null) =>
    entryPath === null ? undefined : records.get(entryPath);

  function write(
    node: LocalWorkspaceManifestNode,
    left: string | null,
    right: string | null,
    children: string | null,
  ): void {
    const previous = records.get(node.path);
    const leftRecord = recordAt(left);
    const rightRecord = recordAt(right);
    const childRecord = recordAt(children);
    const contentRef =
      node.type === "directory"
        ? digest("directory", node.path, childRecord?.treeRef ?? EMPTY_REF)
        : previous?.node === node
          ? previous.contentRef
          : node.type === "file"
            ? digest("file", node.path, node.mode, node.size, node.sha256)
            : digest("symlink", node.path, node.mode, node.target);
    const row: LocalWorkspaceManifestRecord = {
      node,
      left,
      right,
      children,
      contentRef,
      treeRef: digest(
        "siblings",
        leftRecord?.treeRef ?? EMPTY_REF,
        contentRef,
        rightRecord?.treeRef ?? EMPTY_REF,
      ),
    };
    if (previous?.contentRef === contentRef) {
      row.canonicalIdentity = previous.canonicalIdentity;
      row.projectionIdentity = previous.projectionIdentity;
    }
    records.set(node.path, row);
    touched.set(node.path, row);
    removed.delete(node.path);
  }

  function priority(entryPath: string): string {
    let value = priorities.get(entryPath);
    if (value === undefined) {
      value = digest("priority", entryPath);
      priorities.set(entryPath, value);
    }
    return value;
  }

  function precedes(left: string, right: string): boolean {
    const leftPriority = priority(left);
    const rightPriority = priority(right);
    return leftPriority < rightPriority || (leftPriority === rightPriority && left < right);
  }

  function insert(root: string | null, node: LocalWorkspaceManifestNode): string {
    if (root === null) {
      write(node, null, null, null);
      return node.path;
    }
    const row = records.get(root)!;
    if (node.path === root) {
      if (node.type !== "directory" && row.children !== null) {
        throw new Error(`Cannot replace nonempty workspace directory: ${root}`);
      }
      write(node, row.left, row.right, row.children);
      return root;
    }
    if (node.path < root) {
      const next = insert(row.left, node);
      if (precedes(next, root)) {
        const child = records.get(next)!;
        write(row.node, child.right, row.right, row.children);
        write(child.node, child.left, root, child.children);
        return next;
      }
      write(row.node, next, row.right, row.children);
    } else {
      const next = insert(row.right, node);
      if (precedes(next, root)) {
        const child = records.get(next)!;
        write(row.node, row.left, child.left, row.children);
        write(child.node, root, child.right, child.children);
        return next;
      }
      write(row.node, row.left, next, row.children);
    }
    return root;
  }

  function merge(left: string | null, right: string | null): string | null {
    if (left === null || right === null) {
      return left ?? right;
    }
    if (precedes(left, right)) {
      const row = records.get(left)!;
      write(row.node, row.left, merge(row.right, right), row.children);
      return left;
    }
    const row = records.get(right)!;
    write(row.node, merge(left, row.left), row.right, row.children);
    return right;
  }

  function remove(root: string | null, entryPath: string): string | null {
    if (root === null) {
      return null;
    }
    const row = records.get(root)!;
    if (entryPath === root) {
      if (row.children !== null) {
        throw new Error(`Cannot remove nonempty workspace directory: ${root}`);
      }
      const next = merge(row.left, row.right);
      records.delete(root);
      touched.delete(root);
      removed.add(root);
      return next;
    }
    if (entryPath < root) {
      write(row.node, remove(row.left, entryPath), row.right, row.children);
    } else {
      write(row.node, row.left, remove(row.right, entryPath), row.children);
    }
    return root;
  }

  function refresh(root: string, entryPath: string): string {
    const row = records.get(root)!;
    write(
      row.node,
      entryPath < root ? refresh(row.left!, entryPath) : row.left,
      entryPath > root ? refresh(row.right!, entryPath) : row.right,
      row.children,
    );
    return root;
  }

  if (!records.has("")) {
    write({ path: "", type: "directory" }, null, null, null);
  }
  // Descendants disappear before their directories; new ancestors precede children.
  const ordered = changes.toSorted((left, right) => {
    if (Boolean(left.node) !== Boolean(right.node)) {
      return left.node ? 1 : -1;
    }
    const difference = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    return left.node ? difference : -difference;
  });
  for (const change of ordered) {
    if (change.path === "") {
      throw new Error("The workspace manifest root cannot be changed");
    }
    if (!change.node && !records.has(change.path)) {
      continue;
    }
    let directoryPath = parentPath(change.path);
    const directory = records.get(directoryPath);
    if (directory?.node.type !== "directory") {
      throw new Error(`Missing workspace manifest directory: ${directoryPath}`);
    }
    let children = change.node
      ? insert(directory.children, change.node)
      : remove(directory.children, change.path);
    while (true) {
      const row = records.get(directoryPath)!;
      write(row.node, row.left, row.right, children);
      if (directoryPath === "") {
        break;
      }
      const ancestorPath = parentPath(directoryPath);
      children = refresh(records.get(ancestorPath)!.children!, directoryPath);
      directoryPath = ancestorPath;
    }
  }
  return { records: [...touched.values()], removed: [...removed] };
}
