import { describe, expect, it, vi } from "vitest";
import {
  applySessionToolActivityEvent,
  loadSessionActivity,
  type SessionActivityState,
} from "./session-activity.ts";

function createState(overrides: Partial<SessionActivityState> = {}): SessionActivityState {
  return {
    client: null,
    connected: true,
    sessionKey: "agent:main:main",
    sessionActivityLoading: false,
    sessionActivity: null,
    ...overrides,
  };
}

describe("session activity controller", () => {
  it("loads the active task and tool snapshot for the selected session", async () => {
    const request = vi.fn(async () => ({
      key: "agent:main:main",
      revision: 3,
      includedSessionKeys: ["agent:main:main"],
      truncated: false,
      tasks: [],
      tools: [],
    }));
    const state = createState({ client: { request } as never });

    await loadSessionActivity(state);

    expect(request).toHaveBeenCalledWith("sessions.activity", {
      key: "agent:main:main",
      includeDescendants: true,
    });
    expect(state.sessionActivity).toEqual({
      key: "agent:main:main",
      revision: 3,
      includedSessionKeys: ["agent:main:main"],
      truncated: false,
      tasks: [],
      tools: [],
    });
    expect(state.sessionActivityLoading).toBe(false);
  });

  it("adds and removes live exec activity from session tool events", () => {
    const state = createState({
      sessionActivity: {
        key: "agent:main:main",
        revision: 0,
        includedSessionKeys: ["agent:main:main"],
        truncated: false,
        tasks: [],
        tools: [],
      },
    });
    const start = {
      sessionKey: "agent:main:main",
      runId: "run-exec",
      ts: 100,
      data: { phase: "start", name: "exec", toolCallId: "call-exec" },
    };

    applySessionToolActivityEvent(state, start);
    expect(state.sessionActivity?.tools).toEqual([
      expect.objectContaining({ id: "run-exec:call-exec", name: "exec" }),
    ]);

    applySessionToolActivityEvent(state, {
      ...start,
      ts: 200,
      data: { ...start.data, phase: "result" },
    });
    expect(state.sessionActivity?.tools).toEqual([]);
  });
});
