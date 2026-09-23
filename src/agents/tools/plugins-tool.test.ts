import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  validatePluginsInstallParams,
  validatePluginsReloadParams,
  validatePluginsSetEnabledParams,
  validatePluginsUninstallParams,
} from "../../../packages/gateway-protocol/src/validator-registry.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../plugin-runtime-refresh.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { createPluginsTool } from "./plugins-tool.js";

vi.mock("./in-process-gateway.js", () => ({ callAgentToolGatewayRequest: vi.fn() }));

const callGateway = vi.mocked(callAgentToolGatewayRequest);
const runtime = { operationId: "reload-1", generation: 2, pluginIds: ["local-tool"] };

describe("plugins tool", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it("rejects an unsupported install source before dispatch", async () => {
    await expect(
      createPluginsTool().execute("unsupported", { action: "install", source: "local" }),
    ).rejects.toThrow("Unknown plugin installation source: local");
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each(
    ["success", "committed-error", "uncommitted-error"].flatMap((outcome) =>
      [false, true].map((oversized) => ({ outcome, oversized })),
    ),
  )(
    "reports $outcome without an absent continuation consumer (oversized: $oversized)",
    async ({ outcome, oversized }) => {
      const applied = outcome !== "uncommitted-error";
      const warnings = oversized ? ["Cleanup pending: " + "🦞".repeat(2_000)] : [];
      if (outcome === "success") {
        callGateway.mockResolvedValue({ runtime, warnings });
      } else {
        callGateway.mockRejectedValue(
          new GatewayClientRequestError({
            code: "UNAVAILABLE",
            message: "Plugin activation failed",
            details: { runtime: { ...runtime, committed: applied, phase: "activate" }, warnings },
          }),
        );
      }
      const refresh = createAgentPluginRuntimeRefresh();
      try {
        await refresh.run(async () => {
          const result = await createPluginsTool().execute("unsupported-runtime", {
            action: "reload",
            pluginId: "local-tool",
          });
          if (applied) {
            expect(result.details).toMatchObject({
              next: expect.stringContaining("new conversation"),
            });
            expect(JSON.stringify(result.details)).toContain("do not repeat");
          } else {
            expect(JSON.stringify(result.details)).not.toContain("new conversation");
          }
          expect(
            Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8"),
          ).toBeLessThanOrEqual(3_840);
          expect(result.terminate).toBeUndefined();
          expect(captureAgentPluginRuntimeRefresh().isRequested()).toBe(false);
        });
      } finally {
        refresh.close();
      }
    },
  );

  it("keeps saved-install and earlier-publication facts when a later failure exceeds the budget", async () => {
    callGateway.mockRejectedValue(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "Later activation failed",
        details: {
          persistence: { operation: "install", pluginId: "local-tool" },
          runtime: { ...runtime, committed: true, warnings: ["🦞".repeat(2_000)] },
          runtimeAttempt: { ...runtime, generation: 3, committed: false, phase: "prepare" },
        },
      }),
    );
    const result = await createPluginsTool().execute("saved", {
      action: "install",
      source: "official",
      pluginId: "local-tool",
    });
    expect(result).toMatchObject({
      isError: true,
      details: {
        persistence: { operation: "install" },
        runtime: { generation: 2, committed: true },
        warnings: ["🦞".repeat(80)],
        runtimeAttempt: { generation: 3, committed: false, phase: "prepare" },
        next: expect.stringContaining("do not reinstall"),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8")).toBeLessThanOrEqual(
      3_840,
    );
  });

  it.each([
    {
      args: { action: "reload", pluginId: "local-tool" },
      method: "plugins.reload",
      validate: validatePluginsReloadParams,
      params: { plugins: [{ pluginId: "local-tool" }] },
    },
    {
      args: { action: "enable", pluginId: "local-tool" },
      method: "plugins.setEnabled",
      validate: validatePluginsSetEnabledParams,
      params: { pluginId: "local-tool", enabled: true },
    },
    {
      args: { action: "disable", pluginId: "local-tool" },
      method: "plugins.setEnabled",
      validate: validatePluginsSetEnabledParams,
      params: { pluginId: "local-tool", enabled: false },
    },
    {
      args: { action: "uninstall", pluginId: "local-tool" },
      method: "plugins.uninstall",
      validate: validatePluginsUninstallParams,
      params: { pluginId: "local-tool" },
    },
    {
      args: { action: "install", source: "official", pluginId: "local-tool" },
      method: "plugins.install",
      validate: validatePluginsInstallParams,
      params: { source: "official", pluginId: "local-tool" },
    },
    {
      args: { action: "install", source: "clawhub", packageName: "local-tool", version: "1.0.0" },
      method: "plugins.install",
      validate: validatePluginsInstallParams,
      params: { source: "clawhub", packageName: "local-tool", version: "1.0.0" },
    },
  ])(
    "routes $args.action through the authorized management owner",
    async ({ args, method, params, validate }) => {
      callGateway.mockResolvedValue({ runtime, restartRequired: false });
      const refresh = createAgentPluginRuntimeRefresh();
      const signal = new AbortController().signal;
      await refresh.run(async () => {
        captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
        const tool = createPluginsTool();
        const result = await tool.execute("management", args, signal);
        expect(validate(callGateway.mock.calls[0]?.[0].params)).toBe(true);
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
      refresh.close();
    },
  );

  it.each(["1.0.0", "latest"])(
    "rejects unsupported official version %s before dispatch",
    async (version) => {
      const args = { action: "install", source: "official", pluginId: "local-tool", version };
      callGateway.mockResolvedValue({ runtime });
      await expect(createPluginsTool().execute("version", args)).rejects.toThrow(
        "Official catalog installs do not accept a version",
      );
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("retains capability review details without scheduling refresh after rejection", async () => {
    const details = { capabilityConsent: { reviewToken: "review-1", pluginId: "local-tool" } };
    callGateway
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "Review the declared capability change",
          details,
        }),
      )
      .mockResolvedValueOnce({ runtime, restartRequired: false });
    const refresh = createAgentPluginRuntimeRefresh();
    await refresh.run(async () => {
      captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
      const owner = captureAgentPluginRuntimeRefresh();
      const tool = createPluginsTool();
      const result = await tool.execute("review", { action: "reload", pluginId: "local-tool" });
      expect(result).toMatchObject({
        isError: true,
        details: { code: "INVALID_REQUEST", details },
      });
      expect(result.terminate).toBeUndefined();
      expect(owner.isPending()).toBe(false);
      await tool.execute("approved", {
        action: "reload",
        pluginId: "local-tool",
        reviewToken: "review-1",
      });
      expect(callGateway).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
            plugins: [{ pluginId: "local-tool" }],
            acknowledgeCapabilities: { reviewToken: "review-1" },
          },
        }),
      );
      expect(validatePluginsReloadParams(callGateway.mock.calls.at(-1)?.[0].params)).toBe(true);
      expect(owner.isPending()).toBe(true);
    });
    refresh.close();
  });

  it.each([false, true])(
    "refreshes after a failed mutation only if publication committed (%s)",
    async (committed) => {
      const details = { runtime: { ...runtime, phase: "activate", committed } };
      callGateway.mockRejectedValue(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "Plugin service activation failed",
          details,
        }),
      );
      const refresh = createAgentPluginRuntimeRefresh();
      await refresh.run(async () => {
        captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
        const owner = captureAgentPluginRuntimeRefresh();
        const result = await createPluginsTool().execute("failed", {
          action: "reload",
          pluginId: "local-tool",
        });
        expect(result).toMatchObject({
          isError: true,
          details: { error: "Plugin service activation failed", details },
        });
        expect(result.terminate === true).toBe(committed);
        expect(owner.isPending()).toBe(committed);
      });
      refresh.close();
    },
  );

  it("keeps old callback closures fenced after another generation is admitted", async () => {
    const refresh = createAgentPluginRuntimeRefresh();
    callGateway.mockResolvedValue({ runtime });
    const oldTool = refresh.run(() => createPluginsTool());
    refresh.close();
    await refresh.run(async () => {
      captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
      await expect(
        oldTool.execute("stale", { action: "reload", pluginId: "local-tool" }),
      ).rejects.toThrow("Plugin runtime changed");
      expect(callGateway).not.toHaveBeenCalled();
      const nextTool = createPluginsTool();
      await expect(
        nextTool.execute("current", { action: "reload", pluginId: "local-tool" }),
      ).resolves.toMatchObject({ terminate: true });
    });
    refresh.close();
  });

  it.each([
    {
      action: "inspect",
      payload: {
        ok: true,
        declared: { tools: Array.from({ length: 600 }, () => "x") },
        reviewToken: "complete-review-only",
      },
      expected: {},
    },
    {
      action: "search",
      payload: { results: [{ package: { name: "large", summary: "🦞".repeat(2_000) } }] },
      expected: {},
    },
    {
      action: "disable",
      payload: { restartRequired: true, warnings: ["Cleanup pending: " + "🦞".repeat(2_000)] },
      expected: { restartRequired: true, warnings: ["Cleanup pending: " + "🦞".repeat(71)] },
    },
  ])(
    "bounds the complete $action result without exposing a partial review",
    async ({ action, payload, expected }) => {
      callGateway.mockResolvedValue(payload);
      const result = await createPluginsTool().execute("large-result", {
        action,
        pluginId: "local-tool",
        query: "large",
      });
      expect(result).toMatchObject({
        details: { ok: true, detailsOmitted: "response_budget_exceeded", ...expected },
        content: [{ type: "text", text: JSON.stringify(result.details, null, 2) }],
      });
      expect(
        Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8"),
      ).toBeLessThanOrEqual(3_840);
      expect(JSON.stringify(result)).not.toContain("complete-review-only");
      expect(result.terminate).toBeUndefined();
    },
  );

  it.each([undefined, false, true])(
    "retains the publication outcome and continuation when mutation details exceed the budget (%s)",
    async (committed) => {
      const application = {
        ...runtime,
        ...(committed === undefined ? {} : { committed, phase: "activate" }),
      };
      const oversized = {
        restartRequired: false,
        warnings: ["🦞".repeat(2_000), "界".repeat(2_000), "Additional cleanup warning"],
      };
      if (committed === undefined) {
        callGateway.mockResolvedValue({ ok: true, runtime: application, ...oversized });
      } else {
        callGateway.mockRejectedValue(
          new GatewayClientRequestError({
            code: "UNAVAILABLE",
            message: "Activation failed",
            details: {
              runtime: application,
              ...oversized,
              capabilityConsent: { reviewToken: "complete-review-only" },
            },
          }),
        );
      }
      const refresh = createAgentPluginRuntimeRefresh();
      try {
        await refresh.run(async () => {
          captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
          const owner = captureAgentPluginRuntimeRefresh();
          const result = await createPluginsTool().execute("large-mutation", {
            action: "reload",
            pluginId: "local-tool",
          });
          expect(result).toMatchObject({
            details: {
              ok: committed === undefined,
              runtime: { generation: runtime.generation, committed: committed ?? true },
              restartRequired: false,
              warnings: ["🦞".repeat(80), "界".repeat(160)],
              omittedWarningCount: 1,
              detailsOmitted: "response_budget_exceeded",
            },
            content: [{ type: "text", text: JSON.stringify(result.details, null, 2) }],
          });
          if (committed !== undefined) {
            expect(result).toMatchObject({
              isError: true,
              details: { runtime: { phase: "activate" } },
            });
          }
          expect(
            Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8"),
          ).toBeLessThanOrEqual(3_840);
          expect(JSON.stringify(result)).not.toContain("complete-review-only");
          expect(result.terminate === true).toBe(committed ?? true);
          expect(owner.isPending()).toBe(committed ?? true);
        });
      } finally {
        refresh.close();
      }
    },
  );

  it("bounds inventory and narrows it without hiding the omitted count", async () => {
    const plugins = Array.from({ length: 25 }, (_, index) => ({
      id: `plugin-${index}`,
      name: `Plugin ${index}`,
      description: "runtime detail",
      version: "1.0.0",
      state: "enabled",
    }));
    callGateway.mockResolvedValue({ plugins, mutationAllowed: true });
    const tool = createPluginsTool();
    const all = await tool.execute("inventory", { action: "list" });
    expect(all.details).toMatchObject({ matching: 25, omitted: 5, mutationAllowed: true });
    expect((all.details as { plugins: unknown[] }).plugins).toHaveLength(20);
    const narrowed = await tool.execute("filter", { action: "list", query: "plugin-24" });
    expect(narrowed.details).toMatchObject({
      plugins: [{ id: "plugin-24", state: "enabled", version: "1.0.0" }],
      matching: 1,
      omitted: 0,
    });
  });
});
