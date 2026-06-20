import { describe, expect, it } from "vitest";
import { buildWorkSurfaceSnapshot } from "./work-snapshot.ts";

const sessionsResult = {
  ts: 0,
  path: "",
  count: 2,
  sessions: [
    {
      key: "agent:main:main",
      kind: "direct" as const,
      updatedAt: 50,
      hasActiveRun: true,
      displayName: "Main chat",
    },
    {
      key: "agent:main:research",
      kind: "direct" as const,
      updatedAt: 80,
      hasActiveRun: true,
      displayName: "Research lane",
      projectId: "proj-1",
    },
  ],
  defaults: { modelProvider: null, model: null, contextTokens: null },
};

describe("buildWorkSurfaceSnapshot", () => {
  it("returns no items for an idle chat", () => {
    expect(buildWorkSurfaceSnapshot({ currentSessionKey: "agent:main:main" })).toEqual([]);
  });

  it("sorts active run, queued messages, running tasks, queued tasks, and active sessions", () => {
    const items = buildWorkSurfaceSnapshot({
      assistantName: "OpenClaw",
      currentSessionKey: "agent:main:main",
      chatRunId: "run-1",
      chatRunStatus: {
        phase: "done",
        runId: "run-1",
        sessionKey: "agent:main:main",
        occurredAt: 100,
      },
      chatQueue: [{ id: "queue-1", text: "Next step", createdAt: 90 }],
      sessionsResult,
      tasks: [
        {
          id: "task-queued",
          taskId: "task-queued",
          title: "Queued task",
          status: "queued",
          updatedAt: 70,
        },
        {
          id: "task-running",
          taskId: "task-running",
          title: "Running task",
          status: "running",
          progressSummary: "Half done",
          updatedAt: 60,
        },
      ],
    });

    expect(items.map((item) => `${item.kind}:${item.title}`)).toEqual([
      "chat_run:OpenClaw is working…",
      "queued_message:Next step",
      "task:Running task",
      "task:Queued task",
      "active_session:Research lane",
    ]);
    expect(items[0]?.actions).toEqual(["stop_run"]);
    expect(items[1]?.actions).toEqual(["remove_queue"]);
    expect(items[2]?.actions).toEqual(["cancel_task"]);
    expect(items[4]?.actions).toEqual(["open_session"]);
  });

  it("does not show cancel for tasks without an id", () => {
    const items = buildWorkSurfaceSnapshot({
      tasks: [{ title: "Anonymous task", status: "running", updatedAt: 1 }],
    });

    expect(items[0]?.actions).toEqual([]);
  });
});
