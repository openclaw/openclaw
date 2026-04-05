import { describe, expect, it } from "vitest";
import {
  createActivityTree,
  applyActivityEvent,
  computeMetrics,
  flattenTimeline,
  pruneCompletedBranches,
  filterTree,
  serializeTree,
  deserializeTree,
} from "./activity-tree.ts";

function makeEvent(
  runId: string,
  kind: string,
  extra: Record<string, unknown> = {},
  ts = Date.now(),
) {
  return {
    runId,
    ts,
    data: { kind, ...extra },
  };
}

describe("activity-tree", () => {
  it("creates an empty tree", () => {
    const tree = createActivityTree();
    expect(tree.totalNodes).toBe(0);
    expect(tree.rootNodes).toEqual([]);
  });

  it("adds a run.start node", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    expect(tree.totalNodes).toBe(1);
    expect(tree.rootNodes).toHaveLength(1);

    const node = tree.nodeById.get("r1")!;
    expect(node.kind).toBe("run");
    expect(node.status).toBe("running");
    expect(node.label).toBe("main");
  });

  it("completes a run on run.end", () => {
    let tree = createActivityTree();
    const t0 = Date.now();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }, t0));
    tree = applyActivityEvent(tree, makeEvent("r1", "run.end", { agentId: "main" }, t0 + 500));

    const node = tree.nodeById.get("r1")!;
    expect(node.status).toBe("completed");
    expect(node.durationMs).toBe(500);
  });

  it("marks run as error on run.error", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "run.error", { agentId: "main", isError: true, error: "LLM failed" }),
    );

    const node = tree.nodeById.get("r1")!;
    expect(node.status).toBe("error");
    expect(node.isError).toBe(true);
    expect(node.error).toBe("LLM failed");
  });

  it("tracks tool start and end", () => {
    let tree = createActivityTree();
    const t0 = Date.now();
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "read", toolCallId: "tc1" }, t0),
    );
    expect(tree.totalNodes).toBe(1);

    const toolNode = tree.nodeById.get("r1:tool:tc1")!;
    expect(toolNode.kind).toBe("tool");
    expect(toolNode.status).toBe("running");
    expect(toolNode.label).toBe("read");

    tree = applyActivityEvent(
      tree,
      makeEvent(
        "r1",
        "tool.end",
        { toolName: "read", toolCallId: "tc1", durationMs: 120 },
        t0 + 120,
      ),
    );

    expect(toolNode.status).toBe("completed");
    expect(toolNode.durationMs).toBe(120);
  });

  it("tracks subagent events", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "subagent.start", { agentId: "ops", depth: 1 }),
    );
    const node = tree.nodeById.get("r1:subagent:ops")!;
    expect(node.kind).toBe("subagent");
    expect(node.depth).toBe(1);

    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "subagent.end", { agentId: "ops", depth: 1, durationMs: 2000 }),
    );
    expect(node.status).toBe("completed");
    expect(node.durationMs).toBe(2000);
  });

  it("computes metrics correctly", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "exec", toolCallId: "t1" }),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "read", toolCallId: "t2" }),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.end", { toolName: "exec", toolCallId: "t1" }),
    );

    const metrics = computeMetrics(tree);
    expect(metrics.activeRuns).toBe(1);
    expect(metrics.activeTools).toBe(1);
    expect(metrics.totalToolCalls).toBe(2);
    expect(metrics.completedNodes).toBe(1);
    expect(metrics.totalErrors).toBe(0);
  });

  it("flattenTimeline returns sorted entries", () => {
    let tree = createActivityTree();
    const t0 = 1000;
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }, t0));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "exec", toolCallId: "t1" }, t0 + 100),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "read", toolCallId: "t2" }, t0 + 50),
    );

    const timeline = flattenTimeline(tree);
    expect(timeline).toHaveLength(3);
    expect(timeline[0].ts).toBe(t0);
    expect(timeline[1].ts).toBe(t0 + 50);
    expect(timeline[2].ts).toBe(t0 + 100);
  });

  it("prunes completed branches older than maxAge", () => {
    let tree = createActivityTree();
    const oldTs = Date.now() - 10 * 60 * 1000;
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }, oldTs));
    tree = applyActivityEvent(tree, makeEvent("r1", "run.end", { agentId: "main" }, oldTs + 100));
    tree = applyActivityEvent(tree, makeEvent("r2", "run.start", { agentId: "ops" }));

    expect(tree.totalNodes).toBe(2);

    pruneCompletedBranches(tree);
    expect(tree.totalNodes).toBe(1);
    expect(tree.nodeById.has("r1")).toBe(false);
    expect(tree.nodeById.has("r2")).toBe(true);
  });

  it("filterTree filters by kind", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "exec", toolCallId: "t1" }),
    );

    const filtered = filterTree(tree, {
      kinds: new Set(["tool"]),
      search: "",
      timeRangeMs: null,
    });
    expect(filtered.totalNodes).toBe(1);
    expect(filtered.nodeById.has("r1:tool:t1")).toBe(true);
    expect(filtered.nodeById.has("r1")).toBe(false);
  });

  it("filterTree filters by search text", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "read", toolCallId: "t1" }),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "exec", toolCallId: "t2" }),
    );

    const filtered = filterTree(tree, {
      kinds: new Set(["run", "tool", "thinking", "subagent"]),
      search: "read",
      timeRangeMs: null,
    });
    expect(filtered.totalNodes).toBe(1);
    expect(filtered.nodeById.has("r1:tool:t1")).toBe(true);
  });

  it("filterTree filters by time range", () => {
    let tree = createActivityTree();
    const oldTs = Date.now() - 10 * 60 * 1000;
    tree = applyActivityEvent(tree, makeEvent("old", "run.start", { agentId: "main" }, oldTs));
    tree = applyActivityEvent(tree, makeEvent("new", "run.start", { agentId: "ops" }));

    const filtered = filterTree(tree, {
      kinds: new Set(["run", "tool", "thinking", "subagent"]),
      search: "",
      timeRangeMs: 5 * 60 * 1000,
    });
    expect(filtered.totalNodes).toBe(1);
    expect(filtered.nodeById.has("new")).toBe(true);
    expect(filtered.nodeById.has("old")).toBe(false);
  });

  it("nests tools under their parent run node", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "read", toolCallId: "t1" }),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", { toolName: "exec", toolCallId: "t2" }),
    );

    const run = tree.nodeById.get("r1")!;
    expect(run.children).toEqual(["r1:tool:t1", "r1:tool:t2"]);
    expect(tree.rootNodes).toEqual(["r1"]);

    const tool = tree.nodeById.get("r1:tool:t1")!;
    expect(tool.parentId).toBe("r1");
    expect(tool.depth).toBe(1);
  });

  it("nests thinking under parent run", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(tree, makeEvent("r1", "thinking.start", { agentId: "main" }));

    const run = tree.nodeById.get("r1")!;
    expect(run.children).toContain("r1:thinking");
    expect(tree.rootNodes).toEqual(["r1"]);

    const thinking = tree.nodeById.get("r1:thinking")!;
    expect(thinking.parentId).toBe("r1");
    expect(thinking.kind).toBe("thinking");
  });

  it("merges metadata from end events", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", {
        toolName: "read",
        toolCallId: "t1",
        metadata: { args: '{"path":"foo.ts"}' },
      }),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.end", {
        toolName: "read",
        toolCallId: "t1",
        metadata: { result: '"file contents"' },
      }),
    );

    const tool = tree.nodeById.get("r1:tool:t1")!;
    expect(tool.metadata.args).toBe('{"path":"foo.ts"}');
    expect(tool.metadata.result).toBe('"file contents"');
  });

  it("serialize/deserialize round-trips correctly", () => {
    let tree = createActivityTree();
    tree = applyActivityEvent(tree, makeEvent("r1", "run.start", { agentId: "main" }));
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.start", {
        toolName: "exec",
        toolCallId: "t1",
        metadata: { args: '{"cmd":"ls"}' },
      }),
    );
    tree = applyActivityEvent(
      tree,
      makeEvent("r1", "tool.end", { toolName: "exec", toolCallId: "t1", durationMs: 50 }),
    );

    const serialized = serializeTree(tree);
    const json = JSON.stringify(serialized);
    const restored = deserializeTree(JSON.parse(json))!;

    expect(restored).not.toBeNull();
    expect(restored.totalNodes).toBe(tree.totalNodes);
    expect(restored.rootNodes).toEqual(tree.rootNodes);
    expect(restored.nodeById.size).toBe(tree.nodeById.size);

    const run = restored.nodeById.get("r1")!;
    expect(run.kind).toBe("run");
    expect(run.children).toContain("r1:tool:t1");

    const tool = restored.nodeById.get("r1:tool:t1")!;
    expect(tool.kind).toBe("tool");
    expect(tool.status).toBe("completed");
    expect(tool.durationMs).toBe(50);
    expect(tool.metadata.args).toBe('{"cmd":"ls"}');
  });

  it("deserializeTree returns null for invalid data", () => {
    expect(deserializeTree(null)).toBeNull();
    expect(deserializeTree("bad")).toBeNull();
    expect(deserializeTree({})).toBeNull();
  });
});
