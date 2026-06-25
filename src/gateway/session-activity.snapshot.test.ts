import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTasksForRelatedSessionKey: vi.fn(),
}));

vi.mock("../tasks/task-registry.js", () => ({
  listTasksForRelatedSessionKey: mocks.listTasksForRelatedSessionKey,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));

import {
  expandSessionActivityMutation,
  getSessionActivitySnapshot,
  recordSessionToolActivity,
  resetSessionToolActivitiesForTests,
} from "./session-activity.js";

function task(params: {
  taskId: string;
  ownerKey: string;
  childSessionKey?: string;
  status?: "queued" | "running" | "succeeded";
  createdAt?: number;
}) {
  return {
    taskId: params.taskId,
    runtime: "subagent" as const,
    requesterSessionKey: params.ownerKey,
    ownerKey: params.ownerKey,
    scopeKind: "session" as const,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    task: params.taskId,
    status: params.status ?? "running",
    deliveryStatus: "pending" as const,
    notifyPolicy: "done_only" as const,
    createdAt: params.createdAt ?? 1,
  };
}

describe("session activity snapshots", () => {
  afterEach(() => {
    mocks.listTasksForRelatedSessionKey.mockReset();
    resetSessionToolActivitiesForTests();
  });

  it("includes active descendant tasks and live exec work", () => {
    const root = "agent:main:main";
    const child = "agent:main:subagent:child";
    const grandchild = "agent:main:subagent:grandchild";
    const rootTask = task({ taskId: "task-root", ownerKey: root, childSessionKey: child });
    const childTask = task({
      taskId: "task-child",
      ownerKey: child,
      childSessionKey: grandchild,
      createdAt: 2,
    });
    const grandchildTask = task({ taskId: "task-grandchild", ownerKey: grandchild, createdAt: 3 });
    mocks.listTasksForRelatedSessionKey.mockImplementation((key: string) => {
      if (key === root) {
        return [rootTask];
      }
      if (key === child) {
        return [rootTask, childTask];
      }
      if (key === grandchild) {
        return [childTask, grandchildTask];
      }
      return [];
    });

    const mutation = recordSessionToolActivity({
      sessionKey: grandchild,
      event: {
        runId: "run-exec",
        seq: 1,
        stream: "tool",
        ts: 100,
        data: { phase: "start", name: "exec", toolCallId: "call-exec" },
      },
    });
    expect(mutation).toBeDefined();
    expect(expandSessionActivityMutation(mutation!)).toEqual([
      expect.objectContaining({ sessionKey: root }),
      expect.objectContaining({ sessionKey: child }),
      expect.objectContaining({ sessionKey: grandchild, revision: 1 }),
    ]);

    expect(getSessionActivitySnapshot({ key: root })).toMatchObject({
      key: root,
      revision: 1,
      includedSessionKeys: [root, child, grandchild],
      truncated: false,
      tasks: [
        expect.objectContaining({ taskId: "task-grandchild" }),
        expect.objectContaining({ taskId: "task-child" }),
        expect.objectContaining({ taskId: "task-root" }),
      ],
      tools: [expect.objectContaining({ sessionKey: grandchild, name: "exec" })],
    });
  });

  it("can restrict the snapshot to direct session activity", () => {
    const root = "agent:main:main";
    const child = "agent:main:subagent:child";
    const rootTask = task({ taskId: "task-root", ownerKey: root, childSessionKey: child });
    mocks.listTasksForRelatedSessionKey.mockImplementation((key: string) =>
      key === root ? [rootTask] : [],
    );

    expect(getSessionActivitySnapshot({ key: root, includeDescendants: false })).toMatchObject({
      includedSessionKeys: [root],
      tasks: [expect.objectContaining({ taskId: "task-root" })],
      tools: [],
    });
  });
});
