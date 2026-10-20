import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginCliGatewayNodesRuntime } from "./cli-gateway-nodes-runtime.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

describe("createPluginCliGatewayNodesRuntime", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockResolvedValue({});
  });

  it("caps oversized node invoke gateway timeouts", async () => {
    const nodes = createPluginCliGatewayNodesRuntime();

    await nodes.invoke({
      nodeId: "node-1",
      command: "system.run",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
        params: expect.objectContaining({
          timeoutMs: Number.MAX_SAFE_INTEGER,
        }),
      }),
    );
  });

  it.each(["bundled", "global"] as const)(
    "gates requested invoke scopes for %s plugins",
    async (pluginOrigin) => {
      await withPluginRuntimePluginScope({ pluginId: "fixture", pluginOrigin }, () =>
        createPluginCliGatewayNodesRuntime().invoke({
          nodeId: "node-1",
          command: "browser.proxy",
          scopes: ["operator.admin"],
        }),
      );
      expect(callGatewayMock).toHaveBeenCalledWith(
        pluginOrigin === "bundled"
          ? expect.objectContaining({ method: "node.invoke", scopes: ["operator.admin"] })
          : expect.not.objectContaining({ scopes: expect.anything() }),
      );
    },
  );

  it("forwards node invocation cancellation to the Gateway request", async () => {
    const controller = new AbortController();
    const nodes = createPluginCliGatewayNodesRuntime();

    await nodes.invoke({
      nodeId: "node-1",
      command: "ollama.chat",
      signal: controller.signal,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        signal: controller.signal,
      }),
    );
    expect(callGatewayMock.mock.calls[0]?.[0].params).not.toHaveProperty("signal");
  });

  it("rejects duplex commands without opening a polling Gateway fallback", async () => {
    const nodes = createPluginCliGatewayNodesRuntime();

    await expect(nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" })).rejects.toThrow(
      "unavailable in the CLI",
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});
