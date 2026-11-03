import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import * as refreshes from "../plugin-runtime-refresh.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { createPluginsTool } from "./plugins-tool.js";

vi.mock("./in-process-gateway.js", () => ({ callAgentToolGatewayRequest: vi.fn() }));

const callGateway = vi.mocked(callAgentToolGatewayRequest);
const runtime = { operationId: "reload-1", generation: 2, pluginIds: ["local-tool"] };
const reloadArgs = { action: "reload", pluginId: "local-tool" };
type Result = Awaited<ReturnType<ReturnType<typeof createPluginsTool>["execute"]>>;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const execute = (args: Record<string, unknown>) => createPluginsTool().execute("call", args);
const reload = () => execute(reloadArgs);
function fail(
  details: Record<string, unknown>,
  code = "UNAVAILABLE",
  message = "Activation failed",
) {
  callGateway.mockRejectedValueOnce(new GatewayClientRequestError({ code, message, details }));
}
function expectBounded(result: Result, details?: Record<string, unknown>) {
  expect(Buffer.byteLength(json(result.details), "utf8")).toBeLessThanOrEqual(3_840);
  if (details) {
    expect(result).toMatchObject({
      details,
      content: [{ type: "text", text: json(result.details) }],
    });
  }
}
function expectFailure(result: Result, details: Record<string, unknown>) {
  expect(result).toMatchObject({ isError: true });
  expectBounded(result, details);
}

let refresh: ReturnType<typeof refreshes.createAgentPluginRuntimeRefresh>;
function withConsumer(run: (tool: ReturnType<typeof createPluginsTool>) => Promise<void>) {
  return refresh.run(() => {
    refreshes.captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
    return run(createPluginsTool());
  });
}
beforeEach(() => {
  callGateway.mockReset();
  refresh = refreshes.createAgentPluginRuntimeRefresh();
});
afterEach(() => refresh.close());

it("rejects an unsupported install source before dispatch", async () => {
  await expect(execute({ action: "install", source: "local" })).rejects.toThrow(
    "Unknown plugin installation source: local",
  );
  expect(callGateway).not.toHaveBeenCalled();
});

it("keeps saved-install and earlier-publication facts when a later failure exceeds the budget", async () => {
  fail({
    persistence: { operation: "install", pluginId: "local-tool" },
    runtime: { ...runtime, committed: true, warnings: ["🦞".repeat(2_000)] },
    runtimeAttempt: { ...runtime, generation: 3, committed: false, phase: "prepare" },
  });
  const result = await execute({
    action: "install",
    source: "official",
    pluginId: "local-tool",
  });
  expectFailure(result, {
    persistence: { operation: "install" },
    runtime: { generation: 2, committed: true },
    warnings: ["🦞".repeat(80)],
    runtimeAttempt: { generation: 3, committed: false, phase: "prepare" },
    next: expect.stringContaining("do not reinstall"),
  });
});

it.each([
  {
    args: { action: "enable", pluginId: "local-tool" },
    method: "plugins.setEnabled",
    params: { pluginId: "local-tool", enabled: true },
  },
  {
    args: { action: "install", source: "clawhub", packageName: "local-tool", version: "1.0.0" },
    method: "plugins.install",
    params: { source: "clawhub", packageName: "local-tool", version: "1.0.0" },
  },
])(
  "routes $args.action through the authorized management owner",
  async ({ args, method, params }) => {
    callGateway.mockResolvedValue({ runtime, restartRequired: false });
    const signal = new AbortController().signal;
    await withConsumer(async (tool) => {
      const result = await tool.execute("management", args, signal);
      expect(callGateway).toHaveBeenCalledExactlyOnceWith({
        method,
        params,
        signal,
        timeoutMs: null,
      });
      expect(result).toMatchObject({
        details: { runtime, restartRequired: false },
        terminate: true,
      });
      await expect(tool.execute("stale", args, signal)).rejects.toThrow("Plugin runtime changed");
      expect(callGateway).toHaveBeenCalledOnce();
    });
  },
);

it("rejects an official version before dispatch", async () => {
  await expect(
    execute({ action: "install", source: "official", pluginId: "local-tool", version: "1.0.0" }),
  ).rejects.toThrow("Official catalog installs do not accept a version");
  expect(callGateway).not.toHaveBeenCalled();
});

it("retains capability review details without scheduling refresh after rejection", async () => {
  const details = { capabilityConsent: { reviewToken: "review-1", pluginId: "local-tool" } };
  fail(details, "INVALID_REQUEST", "Review the declared capability change");
  callGateway.mockResolvedValueOnce({ runtime, restartRequired: false });
  await withConsumer(async (tool) => {
    const owner = refreshes.captureAgentPluginRuntimeRefresh();
    const result = await tool.execute("review", reloadArgs);
    expectFailure(result, {
      code: "INVALID_REQUEST",
      error: "Review the declared capability change",
      details,
    });
    expect(result.terminate).toBeUndefined();
    expect(owner.isPending()).toBe(false);
    await tool.execute("approved", {
      ...reloadArgs,
      reviewToken: "review-1",
    });
    expect(callGateway.mock.calls.at(-1)?.[0].params).toEqual({
      plugins: [{ pluginId: "local-tool" }],
      acknowledgeCapabilities: { reviewToken: "review-1" },
    });
    expect(owner.isPending()).toBe(true);
  });
});

it("keeps old callback closures fenced after another generation is admitted", async () => {
  callGateway.mockResolvedValue({ runtime });
  const oldTool = refresh.run(() => createPluginsTool());
  refresh.close();
  await withConsumer(async (nextTool) => {
    await expect(oldTool.execute("stale", reloadArgs)).rejects.toThrow("Plugin runtime changed");
    expect(callGateway).not.toHaveBeenCalled();
    await expect(nextTool.execute("current", reloadArgs)).resolves.toMatchObject({
      terminate: true,
    });
  });
});

it.each([
  {
    action: "inspect",
    payload: {
      ok: true,
      declared: { tools: Array.from({ length: 600 }, () => "x") },
      reviewToken: "complete-review-only",
    },
  },
  {
    action: "search",
    payload: { results: [{ package: { name: "large", summary: "🦞".repeat(2_000) } }] },
  },
])(
  "bounds the complete $action result without exposing a partial review",
  async ({ action, payload }) => {
    callGateway.mockResolvedValue(payload);
    const result = await execute({ action, pluginId: "local-tool", query: "large" });
    expectBounded(result, { ok: true, detailsOmitted: "response_budget_exceeded" });
    expect(JSON.stringify(result)).not.toContain("complete-review-only");
    expect(result.terminate).toBeUndefined();
  },
);

it("keeps selected-entry guidance when a compact result requires a restart", async () => {
  callGateway.mockResolvedValue({
    ok: true,
    runtime: {
      ...runtime,
      selectedEntries: { "local-tool": "/plugins/local-tool/dist/index.js" },
    },
    restartRequired: true,
    warnings: ["x".repeat(4_000)],
  });
  const result = await reload();
  expectBounded(result, {
    restartRequired: true,
    runtime: { generation: runtime.generation },
    next: expect.stringContaining(
      "Selected entry: /plugins/local-tool/dist/index.js. Rebuild compiled output after source edits.",
    ),
  });
  expect(result.details).toMatchObject({ next: expect.stringMatching(/restart the Gateway/i) });
  expect(JSON.stringify(result)).not.toContain("Start a new conversation");
});

it.each([false, true])(
  "retains oversized committed errors with continuation consumer=%s",
  async (supported) => {
    fail({
      runtime: { ...runtime, committed: true, phase: "activate" },
      restartRequired: false,
      warnings: ["🦞".repeat(2_000), "界".repeat(2_000), "Additional cleanup warning"],
      capabilityConsent: { reviewToken: "complete-review-only" },
    });
    await refresh.run(async () => {
      const owner = refreshes.captureAgentPluginRuntimeRefresh();
      if (supported) {
        owner.bindConsumer(() => true);
      }
      const tool = createPluginsTool();
      const result = await tool.execute("large-mutation", reloadArgs);
      expectFailure(result, {
        ok: false,
        runtime: { generation: runtime.generation, committed: true, phase: "activate" },
        restartRequired: false,
        warnings: ["🦞".repeat(80), "界".repeat(160)],
        omittedWarningCount: 1,
        detailsOmitted: "response_budget_exceeded",
      });
      expect(JSON.stringify(result)).not.toContain("complete-review-only");
      expect(result.terminate).toBe(supported ? true : undefined);
      expect(owner.isPending()).toBe(supported);
      expect(owner.isRequested()).toBe(supported);
      if (!supported) {
        expect(result.details).toMatchObject({ next: expect.stringContaining("new conversation") });
        expect(JSON.stringify(result.details)).toContain("do not repeat");
      }
    });
  },
);

it.each(["plugin-24", "café"])("bounds inventory and narrows it with %s", async (query) => {
  const plugins = Array.from({ length: 25 }, (_, index) => ({
    id: `plugin-${index}`,
    version: "1.0.0",
    state: "enabled",
    name: index === 24 ? "Cafe\u0301 tools" : undefined,
  }));
  callGateway.mockResolvedValue({ plugins, mutationAllowed: true });
  const tool = createPluginsTool();
  const all = await tool.execute("inventory", { action: "list" });
  expect(all.details).toMatchObject({ matching: 25, omitted: 5, mutationAllowed: true });
  expect((all.details as { plugins: unknown[] }).plugins).toHaveLength(20);
  const narrowed = await tool.execute("filter", { action: "list", query });
  const selected = { id: "plugin-24", state: "enabled", version: "1.0.0" };
  expect(narrowed.details).toMatchObject({ plugins: [selected], matching: 1, omitted: 0 });
});
