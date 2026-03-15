import { describe, expect, it } from "vitest";
import {
  createWorkGraphState,
  listWorkGraphReadyNodeIds,
  markWorkGraphNodeFinished,
  markWorkGraphNodeStarted,
  summarizeWorkGraph,
} from "./work-graph.js";

describe("work graph", () => {
  it("honors finish-to-start dependencies", () => {
    const graph = createWorkGraphState({
      nodeIds: ["a", "b"],
      dependencies: [{ from: "a", to: "b", type: "FS" }],
    });

    expect(listWorkGraphReadyNodeIds(graph)).toEqual(["a"]);

    markWorkGraphNodeStarted(graph, "a", 1);
    expect(listWorkGraphReadyNodeIds(graph)).toEqual([]);

    markWorkGraphNodeFinished({
      state: graph,
      nodeId: "a",
      outcome: "completed",
      endedAt: 2,
    });
    expect(listWorkGraphReadyNodeIds(graph)).toEqual(["b"]);
  });

  it("honors start-to-start dependencies", () => {
    const graph = createWorkGraphState({
      nodeIds: ["a", "b"],
      dependencies: [{ from: "a", to: "b", type: "SS" }],
    });

    expect(listWorkGraphReadyNodeIds(graph)).toEqual(["a"]);
    markWorkGraphNodeStarted(graph, "a", 1);

    expect(listWorkGraphReadyNodeIds(graph)).toEqual(["b"]);
  });

  it("keeps finish-gated nodes running until finish dependencies settle", () => {
    const graph = createWorkGraphState({
      nodeIds: ["a", "b"],
      dependencies: [{ from: "a", to: "b", type: "FF" }],
    });

    markWorkGraphNodeStarted(graph, "a", 1);
    markWorkGraphNodeStarted(graph, "b", 2);
    markWorkGraphNodeFinished({
      state: graph,
      nodeId: "b",
      outcome: "completed",
      endedAt: 3,
    });

    expect(graph.nodes.b.state).toBe("running");

    markWorkGraphNodeFinished({
      state: graph,
      nodeId: "a",
      outcome: "completed",
      endedAt: 4,
    });

    expect(graph.nodes.b.state).toBe("completed");
  });

  it("blocks only downstream dependents when a prerequisite fails", () => {
    const graph = createWorkGraphState({
      nodeIds: ["a", "b", "c"],
      dependencies: [{ from: "a", to: "b", type: "FS" }],
    });

    markWorkGraphNodeStarted(graph, "a", 1);
    markWorkGraphNodeStarted(graph, "c", 1);
    markWorkGraphNodeFinished({
      state: graph,
      nodeId: "a",
      outcome: "failed",
      endedAt: 2,
      failureReason: "boom",
    });
    markWorkGraphNodeFinished({
      state: graph,
      nodeId: "c",
      outcome: "completed",
      endedAt: 3,
    });

    expect(graph.nodes.b.state).toBe("blocked");
    expect(graph.nodes.c.state).toBe("completed");
    expect(summarizeWorkGraph(graph)).toMatchObject({
      failed: 1,
      blocked: 1,
      completed: 1,
    });
  });
});
