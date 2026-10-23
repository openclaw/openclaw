import { describe, expect, it } from "vitest";
import {
  isSessionTranscriptLeafControl,
  mergeSessionTranscriptVisiblePathWithOpaqueAppendPath,
  scanSessionTranscriptTree,
  selectSessionTranscriptLeafControlledPath,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

function leaf(
  id: string,
  parentId: string,
  targetId: string | null,
  extra: Record<string, unknown> = {},
) {
  return { type: "leaf", id, parentId, targetId, ...extra };
}

describe("session transcript tree helpers", () => {
  it("recognizes only valid leaf controls", () => {
    expect(isSessionTranscriptLeafControl(leaf("leaf-control", "old-tail", null))).toBe(true);
    expect(
      isSessionTranscriptLeafControl({
        type: "leaf",
        id: "leaf-control",
        parentId: "old-tail",
      }),
    ).toBe(false);
  });

  it("supports explicit navigation to an empty branch", () => {
    const entries = [
      { type: "message", id: "old-tail", parentId: null },
      leaf("leaf-control", "old-tail", null, { appendParentId: "old-tail" }),
    ];
    expect(scanSessionTranscriptTree(entries)).toMatchObject({
      leafId: null,
      appendParentId: "old-tail",
    });
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([]);
  });

  it("retains a reset kept tail before a disjoint selected branch", () => {
    const keptUser = { type: "message", id: "kept-user", parentId: null };
    const keptAssistant = { type: "message", id: "kept-assistant", parentId: keptUser.id };
    const reset = {
      type: "reset",
      id: "reset-boundary",
      parentId: keptAssistant.id,
      firstKeptEntryId: keptUser.id,
    };
    const branchUser = { type: "message", id: "branch-user", parentId: null };
    const leafControl = leaf("branch-leaf", reset.id, branchUser.id);
    expect(
      selectSessionTranscriptLeafControlledPath([
        keptUser,
        keptAssistant,
        reset,
        branchUser,
        leafControl,
      ]),
    ).toEqual([keptUser, keptAssistant, reset, { ...branchUser, parentId: reset.id }]);
  });

  it("keeps visible history when the next append starts at the root", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const leafControl = leaf("leaf-control", "inactive-tail", "active-root", {
      appendParentId: null,
    });
    expect(selectSessionTranscriptLeafControlledPath([activeRoot, leafControl])).toEqual([
      activeRoot,
    ]);
  });

  it("selects the active path after side rows and later active appends", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const sideEntry = { type: "message", id: "side-entry", parentId: "active-root" };
    const leafControl = leaf("leaf-control", "side-entry", "active-root");
    const activeTail = { type: "message", id: "active-tail", parentId: "active-root" };
    const unlinkedMetadata = { type: "metadata", id: "unlinked-metadata" };
    expect(
      selectSessionTranscriptLeafControlledPath([
        activeRoot,
        sideEntry,
        leafControl,
        activeTail,
        unlinkedMetadata,
      ]),
    ).toEqual([activeRoot, activeTail]);
  });

  it("normalizes parentless continuations after chained leaf markers", () => {
    const activeRoot = { type: "message", id: "active-root", parentId: null };
    const firstLeaf = leaf("first-leaf", "active-root", "active-root");
    const secondLeaf = leaf("second-leaf", "first-leaf", "first-leaf");
    const activeTail = { type: "message", id: "active-tail" };
    const entries = [activeRoot, firstLeaf, secondLeaf, activeTail];
    const tree = scanSessionTranscriptTree(entries);
    expect(tree.byId.get("active-tail")?.parentId).toBe("active-root");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([
      activeRoot,
      { ...activeTail, parentId: "active-root" },
    ]);
  });

  it("keeps the reachable active suffix when an older parent is missing", () => {
    const activeTail = { type: "message", id: "active-tail", parentId: "missing-parent" };
    const leafControl = leaf("leaf-control", "inactive-tail", "active-tail");
    expect(selectSessionTranscriptLeafControlledPath([activeTail, leafControl])).toEqual([
      activeTail,
    ]);
  });

  it("keeps the selected history when a canonical row uses a disjoint raw cursor", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "custom", id: "inactive", parentId: null },
      { type: "metadata", id: "append-root", parentId: "inactive" },
      leaf("active-leaf", "inactive", "visible", {
        appendParentId: "append-root",
        appendMode: "side",
      }),
      { type: "custom", id: "continued", parentId: "append-root" },
    ];
    const tree = scanSessionTranscriptTree(entries);
    expect(tree.byId.get("continued")?.parentId).toBe("visible");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([
      entries[0],
      { ...entries[4], parentId: "visible" },
    ]);
  });

  it("normalizes canonical rows with stale parents onto the active leaf", () => {
    const entries = [
      { type: "message", id: "user", parentId: null },
      { type: "message", id: "assistant", parentId: "user" },
      {
        type: "custom",
        id: "bootstrap-context",
        parentId: "missing-stale-parent",
        customType: "openclaw:bootstrap-context:full",
      },
    ];
    const tree = scanSessionTranscriptTree(entries);
    expect(tree.byId.get("bootstrap-context")?.parentId).toBe("assistant");
    expect(selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id)).toEqual([
      "user",
      "assistant",
      "bootstrap-context",
    ]);
  });

  it("preserves side ancestry after an explicit side append leaf", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "custom", id: "side-one", parentId: "visible" },
      leaf("first-leaf", "side-one", "visible", { appendParentId: "side-one", appendMode: "side" }),
      { type: "custom", id: "side-two", parentId: "side-one", appendMode: "side" },
    ];
    const tree = scanSessionTranscriptTree(entries);
    expect(tree.leafId).toBe("visible");
    expect(tree.appendParentId).toBe("side-two");
    expect(tree.byId.get("side-two")?.parentId).toBe("side-one");
    expect(selectSessionTranscriptLeafControlledPath(entries)).toEqual([entries[0]]);
  });

  it("copies only the opaque suffix of a disjoint append path", () => {
    const entries = [
      { type: "custom", id: "visible", parentId: null },
      { type: "custom", id: "inactive", parentId: null },
      { type: "metadata", id: "append-metadata", parentId: "inactive" },
      { type: "metadata", id: "append-tail", parentId: "append-metadata" },
      leaf("active-leaf", "inactive", "visible", { appendParentId: "append-tail" }),
    ];
    const tree = scanSessionTranscriptTree(entries);
    const merged = mergeSessionTranscriptVisiblePathWithOpaqueAppendPath({
      visiblePath: selectSessionTranscriptTreePathNodes(tree, tree.leafId),
      appendPath: selectSessionTranscriptTreePathNodes(tree, tree.appendParentId),
      appendParentId: tree.appendParentId,
    });
    expect(merged.nodes.map((node) => [node.id, node.selectedParentId])).toEqual([
      ["visible", null],
      ["append-metadata", "visible"],
      ["append-tail", "append-metadata"],
    ]);
    expect(merged.appendParentId).toBe("append-tail");
  });

  it("ignores leaf controls with dangling references", () => {
    const root = { type: "custom", id: "root", parentId: null };
    const missingTarget = leaf("missing-target", "root", "missing");
    const child = { type: "custom", id: "child", parentId: "missing-target" };
    const missingAppendParent = leaf("missing-append", "child", "child", {
      appendParentId: "missing",
    });
    const tree = scanSessionTranscriptTree([root, missingTarget, child, missingAppendParent]);
    expect(tree.leafId).toBe("child");
    expect(tree.appendParentId).toBe("child");
    expect(tree.hasLeafControl).toBe(false);
    expect(tree.byId.get("missing-target")?.parentId).toBe("root");
    expect(tree.byId.get("child")?.parentId).toBe("root");
    expect(selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id)).toEqual([
      "root",
      "child",
    ]);
    expect(selectSessionTranscriptLeafControlledPath([root, missingTarget])).toBeUndefined();
  });
});
