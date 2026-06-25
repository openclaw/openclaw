import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import {
  clearSessionToolActivitiesForRun,
  listSessionToolActivities,
  recordSessionToolActivity,
  resetSessionToolActivitiesForTests,
} from "./session-activity.js";

describe("session tool activity registry", () => {
  afterEach(() => {
    resetSessionToolActivitiesForTests();
    resetGlobalHookRunner();
  });

  it("tracks live exec work until the tool result arrives", () => {
    recordSessionToolActivity({
      sessionKey: "agent:main:main",
      event: {
        runId: "run-exec",
        seq: 1,
        stream: "tool",
        ts: 100,
        data: {
          phase: "start",
          name: "exec",
          toolCallId: "call-exec",
        },
      },
    });

    expect(listSessionToolActivities("agent:main:main")).toEqual([
      expect.objectContaining({
        id: "run-exec:call-exec",
        name: "exec",
        status: "running",
        startedAt: 100,
      }),
    ]);

    recordSessionToolActivity({
      sessionKey: "agent:main:main",
      event: {
        runId: "run-exec",
        seq: 2,
        stream: "tool",
        ts: 200,
        data: {
          phase: "result",
          name: "exec",
          toolCallId: "call-exec",
        },
      },
    });

    expect(listSessionToolActivities("agent:main:main")).toEqual([]);
  });

  it("clears every live tool when its agent run ends", () => {
    for (const toolCallId of ["call-one", "call-two"]) {
      recordSessionToolActivity({
        sessionKey: "agent:main:main",
        event: {
          runId: "run-tools",
          seq: 1,
          stream: "tool",
          ts: 100,
          data: { phase: "start", name: "exec", toolCallId },
        },
      });
    }

    clearSessionToolActivitiesForRun("run-tools");

    expect(listSessionToolActivities("agent:main:main")).toEqual([]);
  });

  it("emits metadata-only typed plugin hooks for live tools", async () => {
    const started = vi.fn();
    const finished = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "tool_started", handler: started },
        { hookName: "tool_finished", handler: finished },
      ]),
    );
    const event = {
      runId: "run-exec",
      seq: 1,
      stream: "tool" as const,
      ts: 100,
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "call-exec",
        args: { command: "secret" },
      },
    };

    recordSessionToolActivity({ sessionKey: "agent:main:main", event });
    recordSessionToolActivity({
      sessionKey: "agent:main:main",
      event: { ...event, seq: 2, data: { ...event.data, phase: "result" } },
    });
    await Promise.resolve();

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "started",
        activity: expect.objectContaining({ name: "exec" }),
      }),
      expect.objectContaining({ sessionKey: "agent:main:main", toolCallId: "call-exec" }),
    );
    expect(finished).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "finished" }),
      expect.anything(),
    );
    expect(started.mock.calls[0]?.[0]).not.toHaveProperty("args");
  });
});
