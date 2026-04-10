import { describe, expect, it, vi } from "vitest";
import {
  clearSourceTaskSelection,
  loadSource,
  loadSourceTaskDetail,
  type SourceState,
} from "./source.ts";

type RequestFn = (method: string, params?: unknown) => Promise<unknown>;

function createState(request: RequestFn, overrides: Partial<SourceState> = {}): SourceState {
  return {
    client: { request } as unknown as SourceState["client"],
    connected: true,
    sourceLoading: false,
    sourceError: null,
    sourceTasks: [],
    sourceTaskSummary: {
      total: 0,
      active: 0,
      terminal: 0,
      failures: 0,
      byStatus: {
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: 0,
        acp: 0,
        cli: 0,
        cron: 0,
      },
    },
    sourceFlows: [],
    sourceSelectedTaskId: null,
    sourceSelectedTask: null,
    sourceSelectedTaskLoading: false,
    ...overrides,
  };
}

describe("loadSource", () => {
  it("loads tasks and flows", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "tasks.list") {
        return {
          tasks: [
            {
              id: "task-1",
              runtime: "subagent",
              sessionKey: "agent:main:main",
              ownerKey: "agent:main:main",
              scope: "session",
              title: "Investigate source lane",
              status: "running",
              deliveryStatus: "not_applicable",
              notifyPolicy: "silent",
              createdAt: 1,
            },
          ],
          summary: {
            total: 1,
            active: 1,
            terminal: 0,
            failures: 0,
            byStatus: {
              queued: 0,
              running: 1,
              succeeded: 0,
              failed: 0,
              timed_out: 0,
              cancelled: 0,
              lost: 0,
            },
            byRuntime: {
              subagent: 1,
              acp: 0,
              cli: 0,
              cron: 0,
            },
          },
        };
      }
      if (method === "tasks.flows.list") {
        return {
          flows: [
            {
              id: "flow-1",
              ownerKey: "agent:main:main",
              status: "blocked",
              notifyPolicy: "state_changes",
              goal: "Ship Source UI",
              createdAt: 1,
              updatedAt: 2,
              tasks: [],
              taskSummary: {
                total: 0,
                active: 0,
                terminal: 0,
                failures: 0,
                byStatus: {
                  queued: 0,
                  running: 0,
                  succeeded: 0,
                  failed: 0,
                  timed_out: 0,
                  cancelled: 0,
                  lost: 0,
                },
                byRuntime: {
                  subagent: 0,
                  acp: 0,
                  cli: 0,
                  cron: 0,
                },
              },
            },
          ],
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request);

    await loadSource(state);

    expect(request).toHaveBeenNthCalledWith(1, "tasks.list", {});
    expect(request).toHaveBeenNthCalledWith(2, "tasks.flows.list", {});
    expect(state.sourceTasks).toHaveLength(1);
    expect(state.sourceFlows).toHaveLength(1);
    expect(state.sourceTaskSummary.total).toBe(1);
    expect(state.sourceLoading).toBe(false);
    expect(state.sourceError).toBeNull();
  });

  it("clears stale selected task when it disappears from the list", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "tasks.list") {
        return {
          tasks: [],
          summary: {
            total: 0,
            active: 0,
            terminal: 0,
            failures: 0,
            byStatus: {
              queued: 0,
              running: 0,
              succeeded: 0,
              failed: 0,
              timed_out: 0,
              cancelled: 0,
              lost: 0,
            },
            byRuntime: {
              subagent: 0,
              acp: 0,
              cli: 0,
              cron: 0,
            },
          },
        };
      }
      if (method === "tasks.flows.list") {
        return { flows: [] };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const state = createState(request, {
      sourceSelectedTaskId: "task-1",
      sourceSelectedTask: {
        id: "task-1",
        runtime: "subagent",
        sessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scope: "session",
        title: "Old task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      },
    });

    await loadSource(state);

    expect(state.sourceSelectedTaskId).toBeNull();
    expect(state.sourceSelectedTask).toBeNull();
  });
});

describe("loadSourceTaskDetail", () => {
  it("loads the selected task detail", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "tasks.show") {
        throw new Error(`unexpected method: ${method}`);
      }
      expect(params).toEqual({ id: "task-1" });
      return {
        task: {
          id: "task-1",
          runtime: "subagent",
          sessionKey: "agent:main:main",
          ownerKey: "agent:main:main",
          scope: "session",
          title: "Inspect detail",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: 1,
          progressSummary: "halfway there",
        },
      };
    });
    const state = createState(request);

    await loadSourceTaskDetail(state, "task-1");

    expect(state.sourceSelectedTaskId).toBe("task-1");
    expect(state.sourceSelectedTask?.progressSummary).toBe("halfway there");
    expect(state.sourceSelectedTaskLoading).toBe(false);
    expect(state.sourceError).toBeNull();
  });
});

describe("clearSourceTaskSelection", () => {
  it("resets selected task state", () => {
    const state = createState(async () => undefined, {
      sourceSelectedTaskId: "task-1",
      sourceSelectedTask: {
        id: "task-1",
        runtime: "subagent",
        sessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scope: "session",
        title: "Selected task",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
      },
      sourceSelectedTaskLoading: true,
    });

    clearSourceTaskSelection(state);

    expect(state.sourceSelectedTaskId).toBeNull();
    expect(state.sourceSelectedTask).toBeNull();
    expect(state.sourceSelectedTaskLoading).toBe(false);
  });
});
