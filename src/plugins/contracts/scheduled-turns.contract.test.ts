import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "../../gateway/server-methods/types.js";
import { withEnv } from "../../test-utils/env.js";
import { cleanupReplacedPluginHostRegistry } from "../host-hook-cleanup.js";
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
import { clearPluginLoaderCache, loadOpenClawPlugins } from "../loader.js";
import { makeTempDir, writePlugin } from "../loader.test-fixtures.js";
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

async function invokePluginGatewayHandler(params: {
  handler: GatewayRequestHandler;
  method: string;
  params?: Record<string, unknown>;
}): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const handlerParams = params.params ?? {};
    const respond = (
      ok: boolean,
      payload?: unknown,
      error?: { message?: string },
      meta?: Record<string, unknown>,
    ) => {
      void meta;
      if (ok) {
        resolve(payload);
        return;
      }
      reject(new Error(error?.message ?? `gateway handler failed: ${params.method}`));
    };
    // Keep this helper pinned to the live request-frame contract so gateway typing drift breaks here first.
    const handlerOptions: GatewayRequestHandlerOptions = {
      req: {
        type: "req",
        id: "test-request",
        method: params.method,
        params: handlerParams,
      },
      params: handlerParams,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as GatewayRequestHandlerOptions["context"],
    };
    Promise.resolve(params.handler(handlerOptions)).catch(reject);
  });
}

describe("plugin scheduled turns", () => {
  afterEach(() => {
    vi.useRealTimers();
    workflowMocks.callGatewayTool.mockReset();
    clearPluginLoaderCache();
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

  it("prefixes explicit untagged schedule names with plugin ownership metadata", async () => {
    workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { id: "job-untagged" };
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
          name: "daily-nudge",
        },
      }),
    ).resolves.toMatchObject({ id: "job-untagged" });

    const addCall = workflowMocks.callGatewayTool.mock.calls.find((args) => args[0] === "cron.add");
    expect((addCall?.[2] as Record<string, unknown>).name).toBe(
      "plugin:workflow-plugin:agent:main:main:daily-nudge",
    );
  });

  it("builds payloads accepted by the real cron.add protocol validator", async () => {
    const { validateCronAddParams } = await import("../../gateway/protocol/index.js");
    workflowMocks.callGatewayTool.mockImplementation(async (method: string, _opts, body) => {
      if (method === "cron.add") {
        expect(validateCronAddParams(body)).toBe(true);
        expect((body as { delivery?: unknown }).delivery).toEqual({
          mode: "announce",
          channel: "last",
        });
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
        },
      }),
    ).resolves.toMatchObject({ id: "cron-compatible-job" });
  });

  it("pages through cron.list when unscheduling tagged turns", async () => {
    const removed: string[] = [];
    const listRequests: unknown[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.list") {
          const offset = (body as { offset?: unknown }).offset;
          listRequests.push(body);
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
          return { ok: true, removed: true };
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
    expect(listRequests).toEqual([
      {
        includeDisabled: true,
        limit: 200,
        query: "plugin:workflow-plugin:tag:nudge:agent:main:main:",
        sortBy: "name",
        sortDir: "asc",
      },
      {
        includeDisabled: true,
        limit: 200,
        offset: 200,
        query: "plugin:workflow-plugin:tag:nudge:agent:main:main:",
        sortBy: "name",
        sortDir: "asc",
      },
    ]);
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

  it("keeps one-shot scheduled-turn records until cleanup confirms the job is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
    const removed: string[] = [];
    workflowMocks.callGatewayTool.mockImplementation(async (method: string, _opts, body) => {
      if (method === "cron.add") {
        return { id: "one-shot-job" };
      }
      if (method === "cron.remove") {
        removed.push((body as { id?: string }).id ?? "");
        return { ok: true, removed: false };
      }
      return { ok: true };
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
      id: "one-shot-job",
      pluginId: "workflow-plugin",
      sessionKey: "agent:main:main",
      kind: "session-turn",
    });
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_999);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toHaveLength(1);

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: "workflow-plugin",
        reason: "disable",
      }),
    ).resolves.toEqual([]);
    expect(removed).toEqual(["one-shot-job"]);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([]);
  });

  it("rejects invalid schedules, unsupported delivery modes, and ambiguous tags before cron.add", async () => {
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
    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          cron: "*/5 * * * *",
          deleteAfterRun: true,
        } as never,
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
          tag: "nudge:followup",
        },
      }),
    ).resolves.toBeUndefined();
    expect(workflowMocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("falls back to a valid delay schedule when a malformed cron value is absent", async () => {
    workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { id: "delay-job" };
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
          cron: undefined,
        } as never,
      }),
    ).resolves.toMatchObject({ id: "delay-job" });

    const addCall = workflowMocks.callGatewayTool.mock.calls.find((args) => args[0] === "cron.add");
    expect((addCall?.[2] as { schedule?: { kind?: string } }).schedule?.kind).toBe("at");
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
          return { ok: true, removed: true };
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

  it("allows bundled plugins to schedule turns during real plugin registration", async () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "loader-scheduler",
      dir: bundledDir,
      filename: "index.cjs",
      body: `module.exports = {
  id: "loader-scheduler",
  register(api) {
    void api.scheduleSessionTurn({
      sessionKey: "agent:main:main",
      message: "wake",
      delayMs: 1
    });
  }
};`,
    });
    workflowMocks.callGatewayTool.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { id: "loader-scheduled-job" };
      }
      if (method === "cron.remove") {
        return { ok: true, removed: true };
      }
      return { ok: true };
    });

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              enabled: true,
              entries: {
                "loader-scheduler": {
                  enabled: true,
                },
              },
            },
          },
        }),
    );

    expect(registry.plugins.find((plugin) => plugin.id === "loader-scheduler")?.status).toBe(
      "loaded",
    );
    await vi.waitFor(() =>
      expect(workflowMocks.callGatewayTool).toHaveBeenCalledWith(
        "cron.add",
        {},
        expect.objectContaining({
          sessionTarget: "session:agent:main:main",
          payload: { kind: "agentTurn", message: "wake" },
        }),
        { scopes: ["operator.admin"] },
      ),
    );
    expect(listPluginSessionSchedulerJobs("loader-scheduler")).toEqual([
      {
        id: "loader-scheduled-job",
        pluginId: "loader-scheduler",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("keeps late scheduled-turn helpers callable from real plugin gateway handlers", async () => {
    const bundledDir = makeTempDir();
    writePlugin({
      id: "loader-scheduler-runtime",
      dir: bundledDir,
      filename: "index.cjs",
      body: `module.exports = {
  id: "loader-scheduler-runtime",
  register(api) {
    const scheduleSessionTurn = api.scheduleSessionTurn;
    const unscheduleSessionTurnsByTag = api.unscheduleSessionTurnsByTag;
    api.registerGatewayMethod("loader-scheduler-runtime.exercise", async ({ respond }) => {
      const first = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake one",
        delayMs: 1,
        tag: "nudge",
      });
      const second = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake two",
        delayMs: 1,
        tag: "nudge",
        deliveryMode: "none",
      });
      const badTag = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "bad tag",
        delayMs: 1,
        tag: "bad:tag",
      });
      const badDelete = await scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "bad delete",
        cron: "0 * * * *",
        deleteAfterRun: true,
        tag: "nudge",
      });
      const removed = await unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      });
      respond(true, {
        first,
        second,
        badTag: badTag ?? null,
        badDelete: badDelete ?? null,
        removed: removed ?? null,
      });
    });
  },
};`,
    });
    const addedJobs: Array<Record<string, unknown>> = [];
    const removedJobIds = new Set<string>();
    workflowMocks.callGatewayTool.mockImplementation(async (method: string, _opts, body) => {
      if (method === "cron.add") {
        const id = `loader-scheduled-job-${addedJobs.length + 1}`;
        addedJobs.push({
          id,
          ...(body as Record<string, unknown>),
        });
        return { id };
      }
      if (method === "cron.list") {
        return {
          jobs: addedJobs.filter((job) => {
            const id = typeof job.id === "string" ? job.id : "";
            return id && !removedJobIds.has(id);
          }),
        };
      }
      if (method === "cron.remove") {
        const id =
          typeof (body as { id?: unknown })?.id === "string" ? (body as { id: string }).id : "";
        if (id) {
          removedJobIds.add(id);
        }
        return { ok: true, removed: true };
      }
      return { ok: true };
    });

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              enabled: true,
              entries: {
                "loader-scheduler-runtime": {
                  enabled: true,
                },
              },
            },
          },
        }),
    );

    expect(
      registry.plugins.find((plugin) => plugin.id === "loader-scheduler-runtime")?.status,
    ).toBe("loaded");
    const handler = registry.gatewayHandlers["loader-scheduler-runtime.exercise"];
    expect(handler).toBeTypeOf("function");
    if (!handler) {
      throw new Error("missing loader-scheduler-runtime.exercise gateway handler");
    }

    await expect(
      invokePluginGatewayHandler({
        handler,
        method: "loader-scheduler-runtime.exercise",
      }),
    ).resolves.toEqual({
      first: {
        id: "loader-scheduled-job-1",
        pluginId: "loader-scheduler-runtime",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
      second: {
        id: "loader-scheduled-job-2",
        pluginId: "loader-scheduler-runtime",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
      badTag: null,
      badDelete: null,
      removed: { removed: 2, failed: 0 },
    });
    expect(addedJobs.map((job) => job.name)).toEqual([
      expect.stringContaining("plugin:loader-scheduler-runtime:tag:nudge:agent:main:main:"),
      expect.stringContaining("plugin:loader-scheduler-runtime:tag:nudge:agent:main:main:"),
    ]);
    expect(addedJobs.map((job) => job.delivery)).toEqual([
      { mode: "announce", channel: "last" },
      { mode: "none" },
    ]);
    expect(listPluginSessionSchedulerJobs("loader-scheduler-runtime")).toEqual([]);
  });

  it("keeps stale scheduled-turn rollback non-throwing when cron cleanup fails", async () => {
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
    ).resolves.toBeUndefined();
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

  it("cleans live dynamic scheduled turns when registry cleanup records are empty", async () => {
    const removed: string[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          return { id: "dynamic-cleanup-job" };
        }
        if (method === "cron.remove") {
          removed.push((body as { id?: string }).id ?? "");
          return { ok: true, removed: true };
        }
        return { ok: true };
      },
    );

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toMatchObject({ id: "dynamic-cleanup-job" });

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: "workflow-plugin",
        reason: "restart",
        records: [],
      }),
    ).resolves.toEqual([]);
    expect(removed).toEqual(["dynamic-cleanup-job"]);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([]);
  });

  it("preserves replacement-generation runtime scheduled turns during restart cleanup", async () => {
    const removed: string[] = [];
    const scheduledIds = ["old-runtime-job", "new-runtime-job"];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          const id = scheduledIds.shift() ?? "unexpected-job";
          return { id };
        }
        if (method === "cron.remove") {
          removed.push((body as { id?: string }).id ?? "");
          return { ok: true, removed: true };
        }
        return { ok: true };
      },
    );

    const previousFixture = createPluginRegistryFixture();
    previousFixture.registry.registry.plugins.push(
      createPluginRecord({
        id: "workflow-plugin",
        name: "Workflow Plugin",
        origin: "bundled",
      }),
    );
    await schedulePluginSessionTurn({
      pluginId: "workflow-plugin",
      pluginName: "Workflow Plugin",
      origin: "bundled",
      ownerRegistry: previousFixture.registry.registry,
      schedule: {
        sessionKey: "agent:main:main",
        message: "old wake",
        delayMs: 1_000,
      },
    });

    const replacementFixture = createPluginRegistryFixture();
    replacementFixture.registry.registry.plugins.push(
      createPluginRecord({
        id: "workflow-plugin",
        name: "Workflow Plugin",
        origin: "bundled",
      }),
    );
    await schedulePluginSessionTurn({
      pluginId: "workflow-plugin",
      pluginName: "Workflow Plugin",
      origin: "bundled",
      ownerRegistry: replacementFixture.registry.registry,
      schedule: {
        sessionKey: "agent:main:main",
        message: "new wake",
        delayMs: 1_000,
      },
    });

    await expect(
      cleanupReplacedPluginHostRegistry({
        cfg: previousFixture.config,
        previousRegistry: previousFixture.registry.registry,
        nextRegistry: replacementFixture.registry.registry,
      }),
    ).resolves.toMatchObject({ failures: [] });
    expect(removed).toEqual(["old-runtime-job"]);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([
      {
        id: "new-runtime-job",
        pluginId: "workflow-plugin",
        sessionKey: "agent:main:main",
        kind: "session-turn",
      },
    ]);
  });

  it("treats already-missing cron jobs as successful scheduled-turn cleanup", async () => {
    const removed: string[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          return { id: "already-missing-job" };
        }
        if (method === "cron.remove") {
          removed.push((body as { id?: string }).id ?? "");
          return { ok: true, removed: false };
        }
        return { ok: true };
      },
    );

    await expect(
      schedulePluginSessionTurn({
        pluginId: "workflow-plugin",
        origin: "bundled",
        schedule: {
          sessionKey: "agent:main:main",
          message: "wake",
          delayMs: 1_000,
        },
      }),
    ).resolves.toMatchObject({ id: "already-missing-job" });

    await expect(
      cleanupPluginSessionSchedulerJobs({
        pluginId: "workflow-plugin",
        reason: "disable",
      }),
    ).resolves.toEqual([]);
    expect(removed).toEqual(["already-missing-job"]);
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([]);
  });

  it("removes only matching plugin tag jobs in the requested session", async () => {
    const removed: string[] = [];
    const listQueries: unknown[] = [];
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.list") {
          listQueries.push((body as { query?: unknown }).query);
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
          return { ok: true, removed: true };
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
    expect(listQueries).toEqual(["plugin:workflow-plugin:tag:nudge:agent:main:main:"]);
    expect(removed.toSorted()).toEqual(["job-a", "job-b"]);
  });

  it("prunes runtime scheduler records after tagged unschedule removes jobs", async () => {
    let addCount = 0;
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.add") {
          addCount += 1;
          return { id: `job-${addCount}` };
        }
        if (method === "cron.list") {
          return {
            jobs: [
              {
                id: "job-1",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:first",
                sessionTarget: "session:agent:main:main",
              },
              {
                id: "job-2",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:second",
                sessionTarget: "session:agent:main:main",
              },
            ],
          };
        }
        if (method === "cron.remove") {
          expect(["job-1", "job-2"]).toContain((body as { id?: unknown }).id);
          return { ok: true, removed: true };
        }
        return { ok: true };
      },
    );

    await schedulePluginSessionTurn({
      pluginId: "workflow-plugin",
      origin: "bundled",
      schedule: {
        sessionKey: "agent:main:main",
        message: "first",
        delayMs: 1_000,
        tag: "nudge",
        name: "first",
      },
    });
    await schedulePluginSessionTurn({
      pluginId: "workflow-plugin",
      origin: "bundled",
      schedule: {
        sessionKey: "agent:main:main",
        message: "second",
        delayMs: 1_000,
        tag: "nudge",
        name: "second",
      },
    });
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toHaveLength(2);

    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge" },
      }),
    ).resolves.toEqual({ removed: 2, failed: 0 });
    expect(listPluginSessionSchedulerJobs("workflow-plugin")).toEqual([]);
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
        if (method === "cron.remove") {
          return { ok: true, removed: true };
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

    workflowMocks.callGatewayTool.mockReset();
    workflowMocks.callGatewayTool.mockImplementation(
      async (method: string, _opts: unknown, body: unknown) => {
        if (method === "cron.list") {
          return {
            jobs: [
              {
                id: "job-missing",
                name: "plugin:workflow-plugin:tag:nudge:agent:main:main:1",
                sessionTarget: "session:agent:main:main",
              },
            ],
          };
        }
        if (method === "cron.remove") {
          expect((body as { id?: string }).id).toBe("job-missing");
          return { ok: true, removed: false };
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
    ).resolves.toEqual({ removed: 0, failed: 1 });
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
    await expect(
      unschedulePluginSessionTurnsByTag({
        pluginId: "workflow-plugin",
        origin: "bundled",
        request: { sessionKey: "agent:main:main", tag: "nudge:followup" },
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
      if (method === "cron.remove") {
        return { ok: true, removed: true };
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

  it("blocks registration-time schedule and unschedule calls before activation", async () => {
    // Drain any cleanup microtasks queued by the previous test's
    // setActivePluginRegistry calls; setActivePluginRegistry schedules
    // cleanup via fire-and-forget dynamic imports that may resolve and
    // invoke callGatewayTool after this test's mockReset.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    workflowMocks.callGatewayTool.mockReset();
    workflowMocks.callGatewayTool.mockResolvedValue({ ok: true });
    const activeFixture = createPluginRegistryFixture();
    setActivePluginRegistry(activeFixture.registry.registry);

    const loadingFixture = createPluginRegistryFixture();
    const loadingApi = loadingFixture.registry.createApi(
      createPluginRecord({
        id: "preactivation-scheduler",
        name: "Preactivation Scheduler",
        origin: "bundled",
      }),
      { config: loadingFixture.config },
    );

    await expect(
      loadingApi.scheduleSessionTurn({
        sessionKey: "agent:main:main",
        message: "wake",
        delayMs: 10,
      }),
    ).resolves.toBeUndefined();
    await expect(
      loadingApi.unscheduleSessionTurnsByTag({
        sessionKey: "agent:main:main",
        tag: "nudge",
      }),
    ).resolves.toEqual({ removed: 0, failed: 0 });
    expect(workflowMocks.callGatewayTool).not.toHaveBeenCalled();
  });
});
