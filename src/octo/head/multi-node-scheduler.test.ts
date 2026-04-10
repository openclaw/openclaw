// Octopus Orchestrator -- MultiNodeScheduler tests (M4-07)
//
// Covers:
//   - 2 nodes with different capabilities route correctly
//   - Full node is skipped
//   - Disconnected node is skipped
//   - No capable node returns null
//   - Node capacity tracking via updateNodeInfo / removeNode
//   - Locality preference (local node preferred over remote)

import { describe, expect, it } from "vitest";
import { MultiNodeScheduler, type NodeInfo } from "./multi-node-scheduler.ts";
import type { SchedulerService } from "./scheduler.ts";

// ──────────────────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<NodeInfo> & { nodeId: string }): NodeInfo {
  return {
    capabilities: [],
    activeArms: 0,
    maxArms: 4,
    connected: true,
    ...overrides,
  };
}

function makeScheduler(): MultiNodeScheduler {
  // The underlying SchedulerService is not exercised by MultiNodeScheduler's
  // own methods; pass a stub satisfying the type constraint.
  const stubScheduler = {} as SchedulerService;
  return new MultiNodeScheduler(stubScheduler, new Map());
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("MultiNodeScheduler", () => {
  it("routes to the correct node based on capabilities", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "node-a",
      makeNode({
        nodeId: "node-a",
        capabilities: ["code-edit", "test-run"],
      }),
    );
    mns.updateNodeInfo(
      "node-b",
      makeNode({
        nodeId: "node-b",
        capabilities: ["code-review"],
      }),
    );

    const resultA = mns.selectBestNode(["code-edit"]);
    expect(resultA).not.toBeNull();
    expect(resultA!.nodeId).toBe("node-a");

    const resultB = mns.selectBestNode(["code-review"]);
    expect(resultB).not.toBeNull();
    expect(resultB!.nodeId).toBe("node-b");
  });

  it("skips a node that is at full capacity", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "full-node",
      makeNode({
        nodeId: "full-node",
        capabilities: ["code-edit"],
        activeArms: 4,
        maxArms: 4,
      }),
    );
    mns.updateNodeInfo(
      "spare-node",
      makeNode({
        nodeId: "spare-node",
        capabilities: ["code-edit"],
        activeArms: 1,
        maxArms: 4,
      }),
    );

    const result = mns.selectBestNode(["code-edit"]);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("spare-node");
  });

  it("skips a disconnected node", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "offline",
      makeNode({
        nodeId: "offline",
        capabilities: ["code-edit"],
        connected: false,
      }),
    );
    mns.updateNodeInfo(
      "online",
      makeNode({
        nodeId: "online",
        capabilities: ["code-edit"],
      }),
    );

    const result = mns.selectBestNode(["code-edit"]);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("online");
  });

  it("returns null when no node has the required capabilities", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "node-a",
      makeNode({
        nodeId: "node-a",
        capabilities: ["code-review"],
      }),
    );

    const result = mns.selectBestNode(["deploy"]);
    expect(result).toBeNull();
  });

  it("tracks node capacity through update and remove", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "node-x",
      makeNode({
        nodeId: "node-x",
        capabilities: ["code-edit"],
        activeArms: 0,
        maxArms: 2,
      }),
    );

    // Partial update: increase active arms.
    mns.updateNodeInfo("node-x", { activeArms: 2 });
    const available = mns.getAvailableNodes(["code-edit"]);
    expect(available).toHaveLength(0);

    // Partial update: free a slot.
    mns.updateNodeInfo("node-x", { activeArms: 1 });
    const availableAfter = mns.getAvailableNodes(["code-edit"]);
    expect(availableAfter).toHaveLength(1);

    // Remove node entirely.
    mns.removeNode("node-x");
    const afterRemove = mns.getAvailableNodes(["code-edit"]);
    expect(afterRemove).toHaveLength(0);
  });

  it("prefers the local node over equally loaded remote nodes", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "remote-1",
      makeNode({
        nodeId: "remote-1",
        capabilities: ["code-edit"],
        activeArms: 1,
        maxArms: 4,
      }),
    );
    mns.updateNodeInfo(
      "local",
      makeNode({
        nodeId: "local",
        capabilities: ["code-edit"],
        activeArms: 1,
        maxArms: 4,
      }),
    );
    mns.updateNodeInfo(
      "remote-2",
      makeNode({
        nodeId: "remote-2",
        capabilities: ["code-edit"],
        activeArms: 0,
        maxArms: 4,
      }),
    );

    const result = mns.selectBestNode(["code-edit"]);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("local");
  });

  it("picks the least loaded node when no local node exists", () => {
    const mns = makeScheduler();
    mns.updateNodeInfo(
      "heavy",
      makeNode({
        nodeId: "heavy",
        capabilities: ["code-edit"],
        activeArms: 3,
        maxArms: 4,
      }),
    );
    mns.updateNodeInfo(
      "light",
      makeNode({
        nodeId: "light",
        capabilities: ["code-edit"],
        activeArms: 1,
        maxArms: 4,
      }),
    );

    const result = mns.selectBestNode(["code-edit"]);
    expect(result).not.toBeNull();
    expect(result!.nodeId).toBe("light");
  });
});
