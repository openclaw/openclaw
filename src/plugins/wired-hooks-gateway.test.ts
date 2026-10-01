/**
 * Test: Gateway and cron lifecycle hook wiring.
 *
 * Since startGatewayServer is heavily integrated, we test the hook runner
 * calls at the unit level by verifying the hook runner functions exist
 * and validating the integration pattern.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { CronJob } from "../cron/types.js";
import type { PluginCoreGatewayHookContext } from "./hook-cron-context.js";
import { createHookRunner } from "./hooks.js";
import {
  addTestHook,
  createHookRunnerWithRegistry,
  createMockPluginRegistry,
} from "./hooks.test-fixtures.js";
import type { PluginServiceCronHost } from "./service-cron.js";
import type {
  PluginHookCronChangedEvent,
  PluginHookCronReconciledContext,
  PluginHookCronReconciledEvent,
  PluginHookGatewayContext,
  PluginHookGatewayCronService,
  PluginHookHandlerMap,
  PluginHookGatewayStopEvent,
} from "./types.js";

type PluginHookGatewayStartEvent = Parameters<PluginHookHandlerMap["gateway_start"]>[0];

function createRawCronHost() {
  let job: CronJob = {
    id: "owner-steward",
    declarationKey: "arxi:proactive-steward:main",
    name: "Owner proactive steward",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "cron", expr: "0 8 * * *" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "proactive steward" },
    state: {},
  };
  const host: PluginServiceCronHost = {
    list: async () => [job],
    getJob: () => job,
    run: async () => ({ ok: true, ran: true }),
    add: async () => job,
    update: async () => job,
    updateWithPrecondition: async (id, patch, precondition, options) => {
      options?.commitGuard?.();
      if (id !== job.id) {
        throw new Error("Cron job not found");
      }
      await precondition(job, Date.now());
      options?.commitGuard?.();
      job = {
        ...job,
        state: { ...job.state, ...patch.state },
        updatedAtMs: job.updatedAtMs + 1,
      };
      return job;
    },
    remove: async () => ({ ok: true, removed: false }),
    removeStaleJobFamily: async () => 0,
  };
  return { host, readJob: () => job };
}

async function expectGatewayHookCall(params: {
  hookName: "gateway_start" | "gateway_stop";
  event: PluginHookGatewayStartEvent | PluginHookGatewayStopEvent;
  gatewayCtx: PluginHookGatewayContext;
}) {
  const handler = vi.fn();
  const { runner } = createHookRunnerWithRegistry([{ hookName: params.hookName, handler }]);

  if (params.hookName === "gateway_start") {
    await runner.runGatewayStart(params.event as PluginHookGatewayStartEvent, params.gatewayCtx);
  } else {
    await runner.runGatewayStop(params.event as PluginHookGatewayStopEvent, params.gatewayCtx);
  }

  expect(handler).toHaveBeenCalledWith(params.event, params.gatewayCtx);
}

describe("gateway hook runner methods", () => {
  const gatewayCtx = {
    port: 18789,
    config: {} as never,
    workspaceDir: "/tmp/openclaw-workspace",
    getCron: () => undefined,
  };
  const cronReconciledCtx: PluginHookCronReconciledContext = {
    ...gatewayCtx,
    abortSignal: new AbortController().signal,
  };

  it.each([
    {
      name: "runGatewayStart invokes registered gateway_start hooks",
      hookName: "gateway_start" as const,
      event: { port: 18789 },
    },
    {
      name: "runGatewayStop invokes registered gateway_stop hooks",
      hookName: "gateway_stop" as const,
      event: { reason: "test shutdown" },
    },
  ] as const)("$name", async ({ hookName, event }) => {
    await expectGatewayHookCall({ hookName, event, gatewayCtx });
  });

  it("runCronChanged invokes registered cron_changed hooks", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "updated",
      jobId: "job-1",
      nextRunAtMs: 123,
      sessionTarget: "main",
      agentId: "main",
      job: {
        id: "job-1",
        agentId: "main",
        sessionTarget: "main",
        state: { nextRunAtMs: 123 },
      },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
  });

  it.each([
    { reason: "startup", enabled: true },
    { reason: "reload", enabled: false },
  ] as const)("runCronReconciled forwards $reason state", async ({ reason, enabled }) => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_reconciled", handler }]);
    const event: PluginHookCronReconciledEvent = { reason, enabled };

    await runner.runCronReconciled(event, cronReconciledCtx);

    expect(handler).toHaveBeenCalledWith(event, cronReconciledCtx);
  });

  it("runCronChanged passes scheduled events with the durable wake snapshot", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "scheduled",
      jobId: "job-scheduled",
      nextRunAtMs: 456,
      sessionTarget: "session:ops",
      agentId: "reporter",
      job: {
        id: "job-scheduled",
        agentId: "reporter",
        sessionTarget: "session:ops",
        state: { nextRunAtMs: 456 },
      },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
  });

  it("runCronChanged passes finished events with delivery and error fields", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "finished",
      jobId: "job-2",
      sessionTarget: "session:ops",
      agentId: "reporter",
      status: "error",
      error: "timeout",
      summary: "Job timed out",
      delivered: false,
      deliveryStatus: "not-delivered",
      deliveryError: "channel unavailable",
      durationMs: 5000,
      runAtMs: 100,
      nextRunAtMs: 200,
      model: "gpt-5.4",
      provider: "openai",
      job: {
        id: "job-2",
        agentId: "reporter",
        sessionTarget: "session:ops",
        state: { lastRunStatus: "error", lastError: "timeout" },
      },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
  });

  it("runCronChanged passes removed events with the deleted job snapshot", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_changed", handler }]);
    const event: PluginHookCronChangedEvent = {
      action: "removed",
      jobId: "job-3",
      sessionTarget: "isolated",
      job: { id: "job-3", name: "deleted-job", sessionTarget: "isolated" },
    };

    await runner.runCronChanged(event, gatewayCtx);

    expect(handler).toHaveBeenCalledWith(event, gatewayCtx);
    const [cronChangedEvent] = expectDefined<unknown[]>(
      handler.mock.calls[0],
      "cron_changed handler",
    );
    expect((cronChangedEvent as PluginHookCronChangedEvent).job).toEqual({
      id: "job-3",
      name: "deleted-job",
      sessionTarget: "isolated",
    });
  });

  it("hasHooks returns true for registered gateway hooks", () => {
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "gateway_start", handler: vi.fn() },
      { hookName: "cron_reconciled", handler: vi.fn() },
      { hookName: "cron_changed", handler: vi.fn() },
    ]);

    expect(runner.hasHooks("gateway_start")).toBe(true);
    expect(runner.hasHooks("cron_reconciled")).toBe(true);
    expect(runner.hasHooks("cron_changed")).toBe(true);
    expect(runner.hasHooks("gateway_stop")).toBe(false);
  });

  it("binds raw gateway cron state to the hook plugin and fences retained handles", async () => {
    const { host, readJob } = createRawCronHost();
    let retained: PluginHookGatewayCronService | undefined;
    const ownerHandler: PluginHookHandlerMap["gateway_start"] = async (_event, context) => {
      retained = expectDefined(context.getCron?.(), "hook cron service");
      await retained.mutateTriggerState("owner-steward", {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: 0,
        value: { revision: 1, timezone: "Europe/Madrid" },
      });
    };
    const ownerRegistry = createMockPluginRegistry([]);
    addTestHook({
      registry: ownerRegistry,
      pluginId: "arxi",
      hookName: "gateway_start",
      handler: ownerHandler,
    });
    const rawContext: PluginCoreGatewayHookContext = {
      config: {} as never,
      getCron: () => host,
    };

    await createHookRunner(ownerRegistry).runGatewayStart({ port: 18789 }, rawContext);

    expect(readJob().state.triggerState).toEqual({
      arxiOwnerBackgroundPolicy: { revision: 1, timezone: "Europe/Madrid" },
    });
    await expect(retained?.list()).rejects.toThrow("no longer active");

    const unrelatedHandler: PluginHookHandlerMap["gateway_start"] = async (_event, context) => {
      const cron = expectDefined(context.getCron?.(), "unrelated hook cron service");
      await cron.mutateTriggerState("owner-steward", {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: 1,
        value: { revision: 2 },
      });
    };
    const unrelatedRegistry = createMockPluginRegistry([]);
    addTestHook({
      registry: unrelatedRegistry,
      pluginId: "unrelated",
      hookName: "gateway_start",
      handler: unrelatedHandler,
    });
    await expect(
      createHookRunner(unrelatedRegistry, { catchErrors: false }).runGatewayStart(
        { port: 18789 },
        rawContext,
      ),
    ).rejects.toThrow("not owned by this plugin");
    expect(readJob().state.triggerState).toEqual({
      arxiOwnerBackgroundPolicy: { revision: 1, timezone: "Europe/Madrid" },
    });
  });

  it("revokes a retained cron handle as soon as a gateway_stop hook times out", async () => {
    const { host, readJob } = createRawCronHost();
    let retained: PluginHookGatewayCronService | undefined;
    const handler: PluginHookHandlerMap["gateway_stop"] = async (_event, context) => {
      retained = expectDefined(context.getCron?.(), "hook cron service");
      await new Promise<void>(() => {});
    };
    const registry = createMockPluginRegistry([]);
    addTestHook({
      registry,
      pluginId: "arxi",
      hookName: "gateway_stop",
      handler,
      timeoutMs: 1,
    });
    const rawContext: PluginCoreGatewayHookContext = {
      config: {} as never,
      getCron: () => host,
    };

    await createHookRunner(registry).runGatewayStop({ reason: "plugin reload" }, rawContext);

    await expect(
      retained?.mutateTriggerState("owner-steward", {
        key: "arxiOwnerBackgroundPolicy",
        expectedRevision: 0,
        value: { revision: 1 },
      }),
    ).rejects.toThrow("no longer active");
    expect(readJob().state.triggerState).toBeUndefined();
  });
});
