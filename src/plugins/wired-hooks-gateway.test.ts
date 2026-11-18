import { describe, expect, it, vi } from "vitest";
import type {
  PluginHookCronChangedEvent,
  PluginHookCronReconciledContext,
  PluginHookCronReconciledEvent,
  PluginHookGatewayContext,
  PluginHookGatewayStopEvent,
} from "./hook-gateway.types.js";
import type { PluginHookHandlerMap } from "./hook-types.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

type PluginHookGatewayStartEvent = Parameters<PluginHookHandlerMap["gateway_start"]>[0];

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

  it("runCronReconciled forwards state", async () => {
    const handler = vi.fn();
    const { runner } = createHookRunnerWithRegistry([{ hookName: "cron_reconciled", handler }]);
    const event: PluginHookCronReconciledEvent = { reason: "reload", enabled: false };

    await runner.runCronReconciled(event, cronReconciledCtx);

    expect(handler).toHaveBeenCalledWith(event, cronReconciledCtx);
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
});
