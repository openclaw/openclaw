import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createLocalWorkspaceManifestTree as createTree,
  localWorkspaceManifestRootReference as rootReference,
  updateLocalWorkspaceManifestTree as updateTree,
  type LocalWorkspaceManifestNode,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";

vi.mock("node:crypto", { spy: true });

function file(path: string, size = 12): LocalWorkspaceManifestNode {
  return { path, type: "file", mode: 0o644, size, sha256: "a".repeat(64) };
}

function directory(path: string): LocalWorkspaceManifestNode {
  return { path, type: "directory" };
}

const rootRef = (records: ReadonlyMap<string, LocalWorkspaceManifestRecord>) =>
  rootReference(records, null);
function expectSameRecords(
  actual: Map<string, LocalWorkspaceManifestRecord>,
  expected: typeof actual,
) {
  for (const [entryPath, record] of actual) {
    expect(JSON.stringify(record)).toBe(JSON.stringify(expected.get(entryPath)));
  }
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
    const forward = createTree(nodes);
    const incremental = createTree([]);
    for (const node of [nodes[4]!, nodes[1]!, nodes[3]!, nodes[2]!, nodes[5]!, nodes[0]!]) {
      updateTree(incremental, [{ path: node.path, node }]);
    }
    expect(materialize(forward)).toEqual(
      nodes.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    );
    expect(materialize(incremental)).toEqual(materialize(forward));
    expectSameRecords(forward, incremental);
    expect(rootRef(incremental)).toBe(rootRef(forward));
    expect(rootReference(forward, "1".repeat(40))).not.toBe(rootRef(forward));
  });

  it("hashes a full baseline only a bounded number of times per path", () => {
    const nodes: LocalWorkspaceManifestNode[] = [];
    for (let index = 0; index < 32; index++) {
      const parent = `dir-${index}`;
      nodes.push(directory(parent), directory(`${parent}/nested`));
      for (let child = 0; child < 16; child++) {
        nodes.push(file(`${parent}/nested/file-${child}`));
      }
    }
    const incremental = new Map<string, LocalWorkspaceManifestRecord>();
    updateTree(
      incremental,
      nodes.map((node) => ({ path: node.path, node })),
    );
    vi.mocked(createHash).mockClear();
    const records = createTree(nodes.toReversed());
    expect(vi.mocked(createHash).mock.calls.length).toBeLessThanOrEqual(4 * (nodes.length + 1));
    expectSameRecords(records, incremental);
  });

  it("persists edits, deletes, renames, modes, symlinks, empty directories and type changes", () => {
    const records = createTree([
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
    const oldRoot = rootRef(records);
    const expected: LocalWorkspaceManifestNode[] = [
      directory("becomes-directory"),
      directory("empty"),
      { ...file("executable"), mode: 0o755 },
      { path: "link", type: "symlink", mode: 0o777, target: "src/new" },
      file("replace"),
      directory("src"),
      { ...file("src/edited"), sha256: "b".repeat(64) },
      file("src/new"),
    ];
    const result = updateTree(records, [
      ...expected.map((node) => ({ path: node.path, node })),
      { path: "src/old" },
      { path: "src/deleted" },
      { path: "replace/child" },
    ]);
    expect(materialize(records)).toEqual(expected);
    expect(rootRef(records)).not.toBe(oldRoot);
    expect(rootRef(records)).toBe(rootRef(createTree(expected)));
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
    expect(rootRef(restored)).toBe(rootRef(records));
    expect(before.get("src/edited")!.node).toEqual(file("src/edited"));
    expect(before.get("src/old")!.node).toEqual(file("src/old"));
  });

  it("requires explicit descendant deletions before removing or replacing a directory", () => {
    const records = createTree([
      directory("src"),
      directory("src/nested"),
      file("src/nested/file"),
    ]);
    const root = rootRef(records);
    expect(() => updateTree(records, [{ path: "src" }])).toThrow(
      "Cannot remove nonempty workspace directory",
    );
    expect(() => updateTree(records, [{ path: "src", node: file("src") }])).toThrow(
      "Cannot replace nonempty workspace directory",
    );
    expect(rootRef(records)).toBe(root);
    const removed = updateTree(records, [
      { path: "src" },
      { path: "src/nested" },
      { path: "src/nested/file" },
    ]);
    expect(removed.removed.toSorted()).toEqual(["src", "src/nested", "src/nested/file"]);
    expect(materialize(records)).toEqual([]);
    expect(rootRef(records)).toBe(rootRef(createTree([])));
  });

  it("changes the root for each content fact while preserving identities for equal content", () => {
    const records = createTree([file("entry")]);
    const variants: LocalWorkspaceManifestNode[] = [
      { ...file("entry"), mode: 0o755 },
      { ...file("entry", 13), mode: 0o755 },
      { ...file("entry", 13), mode: 0o755, sha256: "b".repeat(64) },
      { path: "entry", type: "symlink", mode: 0o777, target: "target" },
      { path: "entry", type: "symlink", mode: 0o777, target: "another" },
      directory("entry"),
    ];
    for (const node of variants) {
      const previousRoot = rootRef(records);
      updateTree(records, [{ path: node.path, node }]);
      expect(rootRef(records)).not.toBe(previousRoot);
      expect(materialize(records)).toEqual([node]);
    }
    const previousRoot = rootRef(records);
    records.set("entry", {
      ...records.get("entry")!,
      canonicalIdentity: "canonical",
      projectionIdentity: "projection",
    });
    updateTree(records, [{ path: "entry", node: directory("entry") }]);
    expect(rootRef(records)).toBe(previousRoot);
    expect(records.get("entry")!.canonicalIdentity).toBe("canonical");
    expect(records.get("entry")!.projectionIdentity).toBe("projection");
  });

  it("updates fewer than 100 records for one edit among 20,000 siblings", () => {
    const records = createTree(
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
    const result = updateTree(records, [{ path: edited, node: file(edited, 100) }]);
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
