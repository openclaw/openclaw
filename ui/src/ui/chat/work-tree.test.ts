import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import { buildAgentWorkTreeSnapshot } from "./work-tree.ts";

const defaults = { contextTokens: null, model: null, modelProvider: null };

function sessions(rows: Array<Partial<GatewaySessionRow> & { key: string }>): SessionsListResult {
  return {
    count: rows.length,
    defaults,
    path: "",
    sessions: rows.map((row) => ({ kind: "direct" as const, updatedAt: 0, ...row })),
    ts: 0,
  };
}

describe("buildAgentWorkTreeSnapshot", () => {
  it("returns an empty tree without a current session", () => {
    expect(buildAgentWorkTreeSnapshot({})).toEqual({
      activeChildCount: 0,
      childCount: 0,
      flat: [],
      root: null,
    });
  });

  it("returns no tree when the current session has no active children", () => {
    const tree = buildAgentWorkTreeSnapshot({
      currentSessionKey: "agent:main:main",
      sessionsResult: sessions([{ key: "agent:main:main", label: "Main" }]),
    });

    expect(tree.root).toBeNull();
    expect(tree.flat).toEqual([]);
  });

  it("builds nested active children from spawnedBy links", () => {
    const tree = buildAgentWorkTreeSnapshot({
      currentSessionKey: "agent:main:main",
      sessionsResult: sessions([
        { key: "agent:main:main", label: "Main" },
        {
          key: "agent:main:subagent:research",
          label: "Researcher",
          spawnedBy: "agent:main:main",
          hasActiveRun: true,
          updatedAt: 20,
        },
        {
          key: "agent:main:subagent:research:subagent:judge",
          label: "Judge",
          parentSessionKey: "agent:main:subagent:research",
          hasActiveSubagentRun: true,
          updatedAt: 25,
        },
      ]),
    });

    expect(tree.childCount).toBe(2);
    expect(tree.activeChildCount).toBe(2);
    expect(tree.flat.map((node) => `${node.depth}:${node.title}:${node.status}`)).toEqual([
      "0:Current chat:Current chat",
      "1:Researcher:Working",
      "2:Judge:Working",
    ]);
  });

  it("uses childSessions links and does not duplicate children", () => {
    const tree = buildAgentWorkTreeSnapshot({
      currentSessionKey: "agent:main:main",
      sessionsResult: sessions([
        {
          key: "agent:main:main",
          childSessions: ["agent:main:subagent:worker", "agent:main:subagent:worker"],
        },
        {
          key: "agent:main:subagent:worker",
          label: "Worker",
          parentSessionKey: "agent:main:main",
          hasActiveRun: true,
        },
      ]),
    });

    expect(tree.flat.map((node) => node.sessionKey)).toEqual([
      "agent:main:main",
      "agent:main:subagent:worker",
    ]);
  });

  it("sorts active children before inactive descendants and newest active first", () => {
    const tree = buildAgentWorkTreeSnapshot({
      currentSessionKey: "agent:main:main",
      sessionsResult: sessions([
        { key: "agent:main:main" },
        {
          key: "agent:main:subagent:old",
          label: "Old active",
          spawnedBy: "agent:main:main",
          hasActiveRun: true,
          updatedAt: 10,
        },
        {
          key: "agent:main:subagent:new",
          label: "New active",
          spawnedBy: "agent:main:main",
          hasActiveRun: true,
          updatedAt: 30,
        },
        {
          key: "agent:main:subagent:done",
          label: "Done",
          spawnedBy: "agent:main:main",
          updatedAt: 50,
        },
      ]),
    });

    expect(tree.flat.map((node) => node.title)).toEqual([
      "Current chat",
      "New active",
      "Old active",
    ]);
  });

  it("attaches cancel actions from matching active tasks", () => {
    const tree = buildAgentWorkTreeSnapshot({
      currentSessionKey: "agent:main:main",
      sessionsResult: sessions([
        { key: "agent:main:main" },
        {
          key: "agent:main:subagent:worker",
          label: "Worker",
          spawnedBy: "agent:main:main",
        },
      ]),
      tasks: [
        {
          id: "task-worker",
          taskId: "task-worker",
          sessionKey: "agent:main:subagent:worker",
          status: "running",
          progressSummary: "Checking proof",
        },
      ],
    });

    const worker = tree.flat.find((node) => node.sessionKey === "agent:main:subagent:worker");
    expect(worker?.status).toBe("Running");
    expect(worker?.detail).toBe("Checking proof");
    expect(worker?.actions).toEqual(["open_session", "cancel_task"]);
    expect(worker?.taskId).toBe("task-worker");
  });

  it("excludes unrelated subagents", () => {
    const tree = buildAgentWorkTreeSnapshot({
      currentSessionKey: "agent:main:main",
      sessionsResult: sessions([
        { key: "agent:main:main" },
        {
          key: "agent:other:subagent:worker",
          label: "Other worker",
          spawnedBy: "agent:other:main",
          hasActiveRun: true,
        },
      ]),
    });

    expect(tree.flat).toEqual([]);
  });
});
