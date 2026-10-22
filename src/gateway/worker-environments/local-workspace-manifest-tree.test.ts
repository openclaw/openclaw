import { describe, expect, it } from "vitest";
import {
  createLocalWorkspaceManifestTree,
  localWorkspaceManifestRootReference,
  updateLocalWorkspaceManifestTree,
  type LocalWorkspaceManifestNode,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";

function file(path: string, size = 12): LocalWorkspaceManifestNode {
  return { path, type: "file", mode: 0o644, size, sha256: "a".repeat(64) };
}

function directory(path: string): LocalWorkspaceManifestNode {
  return { path, type: "directory" };
}

function materialize(
  records: ReadonlyMap<string, LocalWorkspaceManifestRecord>,
): LocalWorkspaceManifestNode[] {
  const result: LocalWorkspaceManifestNode[] = [];
  const visited = new Set<string>();
  function visit(entryPath: string | null, parent: string): void {
    if (entryPath === null) {
      return;
    }
    expect(visited.has(entryPath)).toBe(false);
    visited.add(entryPath);
    const row = records.get(entryPath)!;
    expect(row.node.path).toBe(entryPath);
    expect(entryPath.slice(0, Math.max(0, entryPath.lastIndexOf("/")))).toBe(parent);
    if (row.left !== null) {
      expect(row.left < entryPath).toBe(true);
    }
    if (row.right !== null) {
      expect(row.right > entryPath).toBe(true);
    }
    visit(row.left, parent);
    result.push(row.node);
    if (row.node.type === "directory") {
      visit(row.children, entryPath);
    } else {
      expect(row.children).toBeNull();
    }
    visit(row.right, parent);
  }
  const root = records.get("")!;
  expect(root.node).toEqual(directory(""));
  expect(root.left).toBeNull();
  expect(root.right).toBeNull();
  visit(root.children, "");
  expect(visited.size).toBe(records.size - 1);
  return result.toSorted((left, right) => (left.path < right.path ? -1 : 1));
}

describe("local workspace manifest tree", () => {
  it("has deterministic roots regardless of insertion order, with base commit identity", () => {
    const nodes = [
      file("z-last"),
      directory("src"),
      file("src/first"),
      file("src/second"),
      directory("empty"),
      { path: "link", type: "symlink" as const, mode: 0o777, target: "src/first" },
    ];
    const forward = createLocalWorkspaceManifestTree(nodes);
    const incremental = createLocalWorkspaceManifestTree([]);
    for (const node of [nodes[4]!, nodes[1]!, nodes[3]!, nodes[2]!, nodes[5]!, nodes[0]!]) {
      updateLocalWorkspaceManifestTree(incremental, [{ path: node.path, node }]);
    }
    expect(materialize(forward)).toEqual(
      nodes.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    );
    expect(materialize(incremental)).toEqual(materialize(forward));
    expect(localWorkspaceManifestRootReference(incremental, null)).toBe(
      localWorkspaceManifestRootReference(forward, null),
    );
    expect(localWorkspaceManifestRootReference(forward, "1".repeat(40))).not.toBe(
      localWorkspaceManifestRootReference(forward, null),
    );
  });

  it("persists edits, deletes, renames, modes, symlinks, empty directories and type changes", () => {
    const records = createLocalWorkspaceManifestTree([
      directory("src"),
      file("src/old"),
      file("src/deleted"),
      file("src/edited"),
      file("executable"),
      directory("replace"),
      file("replace/child"),
      file("becomes-directory"),
      { path: "link", type: "symlink", mode: 0o777, target: "src/old" },
    ]);
    const before = new Map(records);
    const oldRoot = localWorkspaceManifestRootReference(records, null);
    const expected: LocalWorkspaceManifestNode[] = [
      directory("becomes-directory"),
      directory("empty"),
      { path: "executable", type: "file", mode: 0o755, size: 12, sha256: "a".repeat(64) },
      { path: "link", type: "symlink", mode: 0o777, target: "src/new" },
      file("replace"),
      directory("src"),
      { path: "src/edited", type: "file", mode: 0o644, size: 12, sha256: "b".repeat(64) },
      file("src/new"),
    ];
    const result = updateLocalWorkspaceManifestTree(records, [
      ...expected.map((node) => ({ path: node.path, node })),
      { path: "src/old" },
      { path: "src/deleted" },
      { path: "replace/child" },
    ]);
    expect(materialize(records)).toEqual(expected);
    expect(localWorkspaceManifestRootReference(records, null)).not.toBe(oldRoot);
    expect(localWorkspaceManifestRootReference(records, null)).toBe(
      localWorkspaceManifestRootReference(createLocalWorkspaceManifestTree(expected), null),
    );
    expect(result.removed.toSorted()).toEqual(["replace/child", "src/deleted", "src/old"]);
    // Applying only returned rows and tombstones must reconstruct the complete persisted tree.
    const restored = new Map(before);
    for (const entryPath of result.removed) {
      restored.delete(entryPath);
    }
    for (const row of result.records) {
      restored.set(row.node.path, structuredClone(row));
    }
    expect(materialize(restored)).toEqual(expected);
    expect(localWorkspaceManifestRootReference(restored, null)).toBe(
      localWorkspaceManifestRootReference(records, null),
    );
    expect(before.get("src/edited")!.node).toEqual(file("src/edited"));
    expect(before.get("src/old")!.node).toEqual(file("src/old"));
  });

  it("requires explicit descendant deletions before removing or replacing a directory", () => {
    const records = createLocalWorkspaceManifestTree([
      directory("src"),
      directory("src/nested"),
      file("src/nested/file"),
    ]);
    const root = localWorkspaceManifestRootReference(records, null);
    expect(() => updateLocalWorkspaceManifestTree(records, [{ path: "src" }])).toThrow(
      "Cannot remove nonempty workspace directory",
    );
    expect(() =>
      updateLocalWorkspaceManifestTree(records, [{ path: "src", node: file("src") }]),
    ).toThrow("Cannot replace nonempty workspace directory");
    expect(localWorkspaceManifestRootReference(records, null)).toBe(root);
    const removed = updateLocalWorkspaceManifestTree(records, [
      { path: "src" },
      { path: "src/nested" },
      { path: "src/nested/file" },
    ]);
    expect(removed.removed.toSorted()).toEqual(["src", "src/nested", "src/nested/file"]);
    expect(materialize(records)).toEqual([]);
    expect(localWorkspaceManifestRootReference(records, null)).toBe(
      localWorkspaceManifestRootReference(createLocalWorkspaceManifestTree([]), null),
    );
  });

  it("changes the root for each content fact while preserving identities for equal content", () => {
    const records = createLocalWorkspaceManifestTree([file("entry")]);
    const variants: LocalWorkspaceManifestNode[] = [
      { path: "entry", type: "file", mode: 0o755, size: 12, sha256: "a".repeat(64) },
      { path: "entry", type: "file", mode: 0o755, size: 13, sha256: "a".repeat(64) },
      { path: "entry", type: "file", mode: 0o755, size: 13, sha256: "b".repeat(64) },
      { path: "entry", type: "symlink", mode: 0o777, target: "target" },
      { path: "entry", type: "symlink", mode: 0o777, target: "another" },
      directory("entry"),
    ];
    for (const node of variants) {
      const previousRoot = localWorkspaceManifestRootReference(records, null);
      updateLocalWorkspaceManifestTree(records, [{ path: node.path, node }]);
      expect(localWorkspaceManifestRootReference(records, null)).not.toBe(previousRoot);
      expect(materialize(records)).toEqual([node]);
    }
    const previousRoot = localWorkspaceManifestRootReference(records, null);
    records.set("entry", {
      ...records.get("entry")!,
      canonicalIdentity: "canonical",
      projectionIdentity: "projection",
    });
    updateLocalWorkspaceManifestTree(records, [{ path: "entry", node: directory("entry") }]);
    expect(localWorkspaceManifestRootReference(records, null)).toBe(previousRoot);
    expect(records.get("entry")!.canonicalIdentity).toBe("canonical");
    expect(records.get("entry")!.projectionIdentity).toBe("projection");
  });

  it("updates fewer than 100 records for one edit among 20,000 siblings", () => {
    const records = createLocalWorkspaceManifestTree(
      Array.from({ length: 20_000 }, (_, index) => file(`file-${String(index).padStart(5, "0")}`)),
    );
    for (const [entryPath, row] of records) {
      records.set(entryPath, {
        ...row,
        canonicalIdentity: `canonical:${entryPath}`,
        projectionIdentity: `projection:${entryPath}`,
      });
    }
    const before = new Map(records);
    const edited = "file-10000";
    const result = updateLocalWorkspaceManifestTree(records, [
      { path: edited, node: file(edited, 100) },
    ]);
    expect(result.removed).toEqual([]);
    expect(result.records.length).toBeLessThan(100);
    const touched = new Set(result.records.map((row) => row.node.path));
    for (const [entryPath, row] of records) {
      if (touched.has(entryPath)) {
        expect(row).not.toBe(before.get(entryPath));
      } else {
        expect(row).toBe(before.get(entryPath));
      }
      if (entryPath === edited || entryPath === "") {
        expect(row.canonicalIdentity).toBeUndefined();
        expect(row.projectionIdentity).toBeUndefined();
      } else {
        expect(row.canonicalIdentity).toBe(`canonical:${entryPath}`);
        expect(row.projectionIdentity).toBe(`projection:${entryPath}`);
      }
    }
    expect(before.get(edited)!.node).toEqual(file(edited));
  });
});
