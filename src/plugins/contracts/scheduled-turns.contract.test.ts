import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginHostRuntimeState,
  cleanupPluginSessionSchedulerJobs,
  listPluginSessionSchedulerJobs,
} from "../host-hook-runtime.js";
import {
  buildPluginSchedulerCronName,
  schedulePluginSessionTurn,
  unschedulePluginSessionTurnsByTag,
} from "../host-hook-workflow.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import type { OpenClawPluginApi } from "../types.js";

const workflowMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));

vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: workflowMocks.callGatewayTool,
}));

describe("plugin scheduled turns", () => {
  afterEach(() => {
    workflowMocks.callGatewayTool.mockReset();
    clearPluginHostRuntimeState();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("builds tagged and untagged cron names", () => {
    expect(
      buildPluginSchedulerCronName({
        pluginId: "workflow-plugin",
        sessionKey: "agent:main:main",
        tag: "nudge",
        uniqueId: "abc",
      }),
    ).toBe("plugin:workflow-plugin:tag:nudge:agent:main:main:abc");
    expect(
      buildPluginSchedulerCronName({
        pluginId: "workflow-plugin",
        sessionKey: "agent:main:main",
        uniqueId: "xyz",
      }),
    ).toBe("plugin:workflow-plugin:agent:main:main:xyz");
  });

  it("schedules session turns with cron-compatible tagged cleanup metadata", async () => {
    workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { payload: { jobId: "job-tagged" } };
      }
      return { ok: true };
    });

    const handle = await schedulePluginSessionTurn({
      pluginId: "workflow-plugin",
      pluginName: "Workflow Plugin",
      origin: "bundled",
      schedule: {
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 1_000,
        tag: "nudge",
        name: "custom-nudge-name",
        deliveryMode: "announce",
      },
    });

    expect(handle).toEqual({
      id: "job-tagged",
      pluginId: "workflow-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    const addCall = workflowMocks.callGatewayTool.mock.calls.find((args) => args[0] === "cron.add");
    expect(addCall).toBeDefined();
    const job = addCall?.[2] as Record<string, unknown>;
    expect(job.name).toBe("plugin:workflow-plugin:tag:nudge:agent:main:main:custom-nudge-name");
    expect(job.sessionTarget).toBe("session:agent:main:main");
    expect(job.deleteAfterRun).toBe(true);
    expect(job.delivery).toEqual({ mode: "announce", channel: "last" });
    expect(job.payload).toMatchObject({
      kind: "agentTurn",
      message: "wake",
    });
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toHaveLength(1);
  });

  it("builds payloads accepted by the real cron.add protocol validator", async () => {
    const { validateCronAddParams } = await import("../../gateway/protocol/index.js");
    workflowMocks.callGatewayTool.mockImplementation(async (method: string, _opts, body) => {
      if (method === "cron.add") {
        expect(validateCronAddParams(body)).toBe(true);
        return { id: "cron-compatible-job" };
      }
      return { ok: true };
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
          tag: "nudge",
          deliveryMode: "announce",
        },
      }),
    ).resolves.toMatchObject({ id: "cron-compatible-job" });
  });

  it("pages through cron.list when unscheduling tagged turns", async () => {
    const removed: string[] = [];
    const listOffsets: unknown[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.list") {
          const offset = (body as { offset?: unknown }).offset;
          listOffsets.push(offset);
          if (offset === undefined) {
            return {
              jobs: [
                {
                  id: "job-page-1",
                  name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
                  sessionTarget: "session:agent:main:main",
                },
              ],
              hasMore: true,
              nextOffset: 200,
            };
          }
          return {
            jobs: [
              {
                id: "job-page-2",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
                sessionTarget: "session:agent:main:main",
              },
            ],
            hasMore: false,
            nextOffset: null,
          };
        }
        if (method === "cron.remove") {
          removed.push((body as { id?: string }).id ?? "");
        }
        return { ok: true };
      },
    );

    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      }),
    ).resolves.toEqual({ removed: 2, failed: 0 });
    expect(listOffsets).toEqual([undefined, 200]);
    expect(removed.toSorted()).toEqual(["job-page-1", "job-page-2"]);
  });

  it("tracks scheduled session turns using cron.add's top-level job id", async () => {
    workflowMocks.callGatewayTool.mockResolvedValueOnce({
      id: "cron-top-level-id",
      payload: {
        id: "payload-body-id",
        kind: "agentTurn",
      },
    });

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        pluginName: "Workflow Plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toEqual({
      id: "cron-top-level-id",
      pluginId: "workflow-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([
      {
        id: "cron-top-level-id",
        pluginId: "workflow-plugin",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("rejects invalid schedules and unsupported delivery modes before cron.add", async () => {
    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: -1,
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
          deliveryMode: "unsupported" as never,
        },
      }),
    ).resolves.toBeUndefined();
    expect(workflowMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("removes a stale cron job when the plugin unloads after cron.add", async () => {
    let commit = true;
    const removed: string[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          commit = false;
          return { payload: { jobId: "job-stale" } };
        }
        if (method === "cron.remove") {
          removed.push((body as { id?: string }).id ?? "");
        }
        return { ok: true };
      },
    );

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: { sessionKey: "agent:main:main", message: "wake", delayMs: 1 },
        shouldCommit: () => commit,
      }),
    ).resolves.toBeUndefined();
    expect(removed).toEqual(["job-stale"]);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([]);
  });

  it("fails stale scheduled-turn rollback when cron cleanup fails", async () => {
    let commit = true;
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          commit = false;
          return { id: "job-stale" };
        }
        if (method === "cron.remove") {
          throw new Error(`remove failed for ${(body as { id?: string }).id}`);
        }
        return { ok: true };
      },
    );

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: { sessionKey: "agent:main:main", message: "wake", delayMs: 1 },
        shouldCommit: () => commit,
      }),
    ).rejects.toThrow("failed to remove stale scheduled session turn: job-stale");
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([]);
  });

  it("keeps scheduled-turn records when cleanup fails", async () => {
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          return { id: "cleanup-failure-job" };
        }
        if (method === "cron.remove") {
          throw new Error(`remove failed for ${(body as { id?: string }).id}`);
        }
        return { ok: true };
      },
    );

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        pluginName: "Workflow Plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toMatchObject({ id: "cleanup-failure-job" });

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: "workflow-plugin",
        reason: "disable",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        pluginId: "workflow-plugin",
        hookId: "scheduler:cleanup-failure-job",
      }),
    ]);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([
      {
        id: "cleanup-failure-job",
        pluginId: "workflow-plugin",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("removes only matching plugin tag jobs in the requested session", async () => {
    const removed: string[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.list") {
          return {
            jobs: [
              {
                id: "job-a",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
                sessionTarget: "session:agent:main:main",
              },
              {
                id: "job-b",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
                sessionTarget: "session:agent:main:main",
              },
              {
                id: "job-c",
                name: "plugin:other-plugin:tag:nudge:agent:main:main:1",
                sessionTarget: "session:agent:main:main",
              },
              {
                id: "job-d",
                name: "plugin:workflow-plugin:tag:nudge:agent:other:main:1",
                sessionTarget: "session:agent:other:main",
              },
            ],
          };
        }
        if (method === "cron.remove") {
          removed.push((body as { id?: string }).id ?? "");
        }
        return { ok: true };
      },
    );

    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      }),
    ).resolves.toEqual({ removed: 2, failed: 0 });
    expect(removed.toSorted()).toEqual(["job-a", "job-b"]);
  });

  it("counts cron.list and cron.remove failures when unscheduling by tag", async () => {
    workflowMocks.callGatewayTool.mockRejectedValueOnce(new Error("cron list unavailable"));
    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      }),
    ).resolves.toEqual({ removed: 0, failed: 1 });

    workflowMocks.callGatewayTool.mockReset();
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.list") {
          return {
            jobs: [
              {
                id: "job-ok",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
                sessionTarget: "session:agent:main:main",
              },
              {
                id: "job-fail",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:2",
                sessionTarget: "session:agent:main:main",
              },
            ],
          };
        }
        if (method === "cron.remove" && (body as { id?: string }).id === "job-fail") {
          throw new Error("remove failed");
        }
        return { ok: true };
      },
    );

    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      }),
    ).resolves.toEqual({ removed: 1, failed: 1 });
  });

  it("does not unschedule turns for non-bundled plugins or invalid tag requests", async () => {
    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "workspace",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "   " },
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
    expect(workflowMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("wires schedule and unschedule through the plugin API with stale-registry protection", async () => {
    workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { payload: { jobId: "job-live" } };
      }
      if (method === "cron.list") {
        return { jobs: [] };
      }
      return { ok: true };
    });
    const { config, registry } = createPluginRegistryFixture();
    let capturedApi: OpenClawPluginApi | undefined;
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "scheduler-plugin",
        name: "Scheduler Plugin",
        origin: "bundled",
      }),
      register(api) {
        capturedApi = api;
      },
    });
    setActivePluginRegistry(registry.registry);

    await expect(
      capturedApi?.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 10,
      }),
    ).resolves.toMatchObject({ id: "job-live", pluginId: "scheduler-plugin" });
    await expect(
      capturedApi?.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      capturedApi?.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 10,
      }),
    ).resolves.toBeUndefined();
    await expect(
      capturedApi?.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
  });
});
