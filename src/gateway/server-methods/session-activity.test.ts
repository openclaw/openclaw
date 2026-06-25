import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionActivitySnapshot: vi.fn(),
}));

vi.mock("../session-activity.js", () => ({
  getSessionActivitySnapshot: mocks.getSessionActivitySnapshot,
}));

import { sessionActivityHandlers } from "./session-activity.js";

describe("sessions.activity", () => {
  it("returns active durable tasks and live tools for one session", async () => {
    mocks.getSessionActivitySnapshot.mockReturnValue({
      key: "agent:main:main",
      revision: 4,
      includedSessionKeys: ["agent:main:main", "agent:main:subagent:child"],
      truncated: false,
      tasks: [
        {
          taskId: "task-running",
          requesterSessionKey: "agent:main:main",
          runtime: "subagent",
          task: "Investigate issue",
          status: "running",
          createdAt: 100,
          startedAt: 120,
          lastEventAt: 130,
          childSessionKey: "agent:main:subagent:child",
          runId: "run-subagent",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          ownerKey: "agent:main:main",
          scopeKind: "session",
        },
        {
          taskId: "task-done",
          requesterSessionKey: "agent:main:main",
          runtime: "cron",
          task: "Completed job",
          status: "succeeded",
          createdAt: 10,
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          ownerKey: "agent:main:main",
          scopeKind: "session",
        },
      ],
      tools: [
        {
          id: "run-exec:call-exec",
          sessionKey: "agent:main:main",
          runId: "run-exec",
          toolCallId: "call-exec",
          name: "exec",
          title: "exec",
          status: "running",
          startedAt: 150,
          updatedAt: 160,
        },
      ],
    });
    const respond = vi.fn();

    await sessionActivityHandlers["sessions.activity"]({
      params: { key: "agent:main:main" },
      respond,
    } as never);

    expect(respond).toHaveBeenCalledWith(true, {
      key: "agent:main:main",
      revision: 4,
      includedSessionKeys: ["agent:main:main", "agent:main:subagent:child"],
      truncated: false,
      tasks: [
        expect.objectContaining({
          id: "task-running",
          runtime: "subagent",
          status: "running",
          childSessionKey: "agent:main:subagent:child",
        }),
      ],
      tools: [expect.objectContaining({ name: "exec", status: "running" })],
    });
    expect(mocks.getSessionActivitySnapshot).toHaveBeenCalledWith({
      key: "agent:main:main",
      includeDescendants: undefined,
    });
  });
});
