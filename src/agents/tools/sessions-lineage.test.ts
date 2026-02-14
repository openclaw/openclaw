import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../subagent-registry.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "../subagent-registry.js";
import {
  getAncestors,
  getDescendants,
  getSubtreeLeafFirst,
  isInLineage,
} from "./sessions-lineage.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tempStateDir: string | null = null;

function addRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  childKeys?: string[];
  depth?: number;
}) {
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: "test",
    task: "test",
    cleanup: "keep",
    createdAt: Date.now(),
    depth: params.depth,
    childKeys: params.childKeys ? new Set(params.childKeys) : undefined,
  } as SubagentRunRecord);
}

beforeEach(async () => {
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lineage-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(async () => {
  resetSubagentRegistryForTests({ persist: false });
  if (tempStateDir) {
    await fs.rm(tempStateDir, { recursive: true, force: true });
    tempStateDir = null;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("sessions lineage", () => {
  it("getAncestors returns correct chain for 3-level hierarchy", () => {
    const root = "agent:main:main";
    const child1 = "agent:main:subagent:child-1";
    const child2 = "agent:main:subagent:child-2";
    const child3 = "agent:main:subagent:child-3";
    addRun({ runId: "run-1", childSessionKey: child1, requesterSessionKey: root });
    addRun({ runId: "run-2", childSessionKey: child2, requesterSessionKey: child1 });
    addRun({ runId: "run-3", childSessionKey: child3, requesterSessionKey: child2 });

    expect(getAncestors(child3)).toEqual([child2, child1, root]);
  });

  it("getAncestors returns empty for root", () => {
    expect(getAncestors("agent:main:main")).toEqual([]);
  });

  it("getDescendants returns correct tree", () => {
    const root = "agent:main:subagent:root";
    const childA = "agent:main:subagent:a";
    const childB = "agent:main:subagent:b";
    const leaf = "agent:main:subagent:leaf";
    addRun({
      runId: "run-root",
      childSessionKey: root,
      requesterSessionKey: "agent:main:main",
      childKeys: [childA, childB],
    });
    addRun({
      runId: "run-a",
      childSessionKey: childA,
      requesterSessionKey: root,
      childKeys: [leaf],
    });
    addRun({ runId: "run-b", childSessionKey: childB, requesterSessionKey: root });
    addRun({ runId: "run-leaf", childSessionKey: leaf, requesterSessionKey: childA });

    expect(getDescendants(root)).toEqual([childA, childB, leaf]);
  });

  it("getDescendants from root without a run record finds children via scan", () => {
    const root = "agent:main:main";
    const child = "agent:main:subagent:child";
    const leaf = "agent:main:subagent:leaf";
    addRun({ runId: "run-child", childSessionKey: child, requesterSessionKey: root });
    addRun({ runId: "run-leaf", childSessionKey: leaf, requesterSessionKey: child });

    expect(getDescendants(root)).toEqual([child, leaf]);
  });

  it("isInLineage is true for ancestors/descendants and false for unrelated sessions", () => {
    const root = "agent:main:main";
    const child = "agent:main:subagent:child";
    const leaf = "agent:main:subagent:leaf";
    const unrelated = "agent:other:subagent:other";
    addRun({ runId: "run-child", childSessionKey: child, requesterSessionKey: root });
    addRun({ runId: "run-leaf", childSessionKey: leaf, requesterSessionKey: child });

    expect(isInLineage(child, root)).toBe(true);
    expect(isInLineage(child, leaf)).toBe(true);
    expect(isInLineage(child, unrelated)).toBe(false);
  });

  it("cycle protection prevents infinite loops", () => {
    const a = "agent:main:subagent:a";
    const b = "agent:main:subagent:b";
    addRun({ runId: "run-a", childSessionKey: a, requesterSessionKey: b });
    addRun({ runId: "run-b", childSessionKey: b, requesterSessionKey: a });

    expect(getAncestors(a)).toEqual([b, a]);
    expect(getDescendants(a)).toEqual([b]);
  });

  it("getSubtreeLeafFirst returns leaves before parents", () => {
    const root = "agent:main:subagent:root";
    const childA = "agent:main:subagent:a";
    const childB = "agent:main:subagent:b";
    const leaf = "agent:main:subagent:leaf";
    addRun({
      runId: "run-root",
      childSessionKey: root,
      requesterSessionKey: "agent:main:main",
      childKeys: [childA, childB],
    });
    addRun({
      runId: "run-a",
      childSessionKey: childA,
      requesterSessionKey: root,
      childKeys: [leaf],
    });
    addRun({ runId: "run-b", childSessionKey: childB, requesterSessionKey: root });
    addRun({ runId: "run-leaf", childSessionKey: leaf, requesterSessionKey: childA });

    expect(getSubtreeLeafFirst(root)).toEqual([leaf, childB, childA, root]);
  });
});
