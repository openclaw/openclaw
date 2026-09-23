import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import {
  callGatewayToolMock,
  createVisionComputerTool,
  gatewayComputerStatusMock,
  listNodesMock,
  loadPairedComputerUseAvailabilityForSurface,
  macComputerNode,
  readActionEnum,
  readFrameId,
  resetComputerToolMocks,
  screenshotPayload,
  v2Descriptor,
} from "./computer-tool.test-helpers.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";

beforeEach(resetComputerToolMocks);
const authorities: AgentRunDelegatedAuthority[] = [];
afterEach(() => {
  for (const authority of authorities.splice(0)) {
    releaseAgentRunDelegatedAuthority(authority);
  }
});

function createHostedComputerTool(options: Parameters<typeof createVisionComputerTool>[0] = {}) {
  const gatewayContext = {} as GatewayRequestContext;
  const operationalRunInstance = createOperationalRunInstanceRef("computer-test");
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  authorities.push(authority);
  return wrapToolWithGatewayCallerIdentity(createVisionComputerTool(options), {
    agentId: "main",
    sessionKey: "agent:main:computer-test",
    operationalRunInstance,
    approvalAuthority: authority,
    gatewayContextResolver: () => gatewayContext,
    receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
  });
}

describe("computer Gateway and node targets", () => {
  it.each([
    { gatewayUrl: "wss://released-gateway.example" },
    { gatewayToken: "fixture-token" },
    { gatewayUrl: "wss://released-gateway.example", gatewayToken: "fixture-token" },
  ])("preserves v2026.9.4 implicit remote-node selection with %j", async (gatewayOptions) => {
    const [nodes, computer] = await Promise.all([
      vi.importActual<typeof import("./nodes-utils.js")>("./nodes-utils.js"),
      vi.importActual<typeof import("./computer-tool-gateway.js")>("./computer-tool-gateway.js"),
    ]);
    listNodesMock.mockImplementation(nodes.listNodes);
    gatewayComputerStatusMock.mockImplementation(computer.loadGatewayComputerStatus);
    // v2026.9.4 exposes these paired-node methods, but no computer.status/invoke.
    callGatewayToolMock.mockImplementation(async (method, _options, request) => {
      if (method === "node.list") {
        return { nodes: [macComputerNode()] };
      }
      if (method === "node.invoke") {
        return request.command === "screen.snapshot"
          ? screenshotPayload()
          : { payload: { ok: true } };
      }
      throw new Error(`unknown method: ${method}`);
    });
    const tool = createVisionComputerTool();
    const screenshot = await tool.execute("observe", { action: "screenshot", ...gatewayOptions });
    expect(screenshot.details).toMatchObject({ node: "mac-1" });
    await tool.execute("input", { action: "type", text: "fixture" });
    expect(callGatewayToolMock.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
      "node.invoke",
      "node.invoke",
      "node.invoke",
    ]);
    for (const [, options] of callGatewayToolMock.mock.calls) {
      expect(options).toMatchObject(gatewayOptions);
    }
    expect(gatewayComputerStatusMock).not.toHaveBeenCalled();
    await expect(
      tool.execute("unsupported-host", {
        action: "screenshot",
        target: "gateway",
        ...gatewayOptions,
      }),
    ).rejects.toThrow("one persistent operator RPC connection");
    expect(callGatewayToolMock).toHaveBeenCalledTimes(4);
    expect(gatewayComputerStatusMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "gateway"] as const)(
    "refreshes failed prepared discovery for target %s",
    async (target) => {
      const unavailable = {
        configured: true as const,
        available: false as const,
        error: "Desktop temporarily unavailable",
      };
      gatewayComputerStatusMock
        .mockResolvedValueOnce(unavailable)
        .mockResolvedValueOnce(unavailable)
        .mockResolvedValue({
          configured: true,
          available: true,
          computerUse: v2Descriptor(["screenshot"]),
        });
      listNodesMock.mockResolvedValue([]);
      const availability = await loadPairedComputerUseAvailabilityForSurface({
        computerAllowed: true,
      });
      const tool = createHostedComputerTool({ pairedNodeComputerUse: availability?.prepared });
      await expect(tool.execute("unavailable", { action: "screenshot", target })).rejects.toThrow(
        "Desktop temporarily unavailable",
      );
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      const screenshot = await tool.execute("recovered", { action: "screenshot", target });
      expect(screenshot.details).toMatchObject({ target: "gateway" });
      expect(gatewayComputerStatusMock).toHaveBeenCalledTimes(3);
      expect(listNodesMock).toHaveBeenCalledOnce();
      expect(callGatewayToolMock.mock.calls.every(([method]) => method === "computer.invoke")).toBe(
        true,
      );
    },
  );

  it.each([false, true])(
    "rejects ephemeral Gateway connections (override=%s)",
    async (override) => {
      gatewayComputerStatusMock.mockResolvedValue({
        configured: true,
        available: true,
        computerUse: v2Descriptor(["screenshot"]),
      });
      const tool = override ? createHostedComputerTool() : createVisionComputerTool();
      await expect(
        tool.execute("observe", {
          action: "screenshot",
          target: "gateway",
          ...(override ? { gatewayUrl: "ws://localhost:18789" } : {}),
        }),
      ).rejects.toThrow("one persistent operator RPC connection");
      expect(callGatewayToolMock).not.toHaveBeenCalled();
      expect(listNodesMock).not.toHaveBeenCalled();
    },
  );
  it("publishes Gateway capabilities and controls its desktop without a paired node", async () => {
    const computerUse = v2Descriptor(["screenshot", "left_click", "list_windows"]);
    gatewayComputerStatusMock.mockResolvedValue({ configured: true, available: true, computerUse });
    listNodesMock.mockResolvedValue([]);
    const availability = await loadPairedComputerUseAvailabilityForSurface({
      computerAllowed: true,
      modelHasVision: true,
    });
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createHostedComputerTool({
      pairedNodeComputerUse: availability?.prepared,
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    expect(readActionEnum(tool)).toContain("list_windows");
    expect(tool.description).toContain("Gateway desktop");
    const screenshot = await tool.execute("observe", { action: "screenshot" });
    expect(screenshot.details).toMatchObject({ target: "gateway" });
    expect(screenshot.details).not.toHaveProperty("node");
    await tool.execute("click", {
      action: "left_click",
      coordinate: [0, 0],
      frameId: readFrameId(screenshot),
    });
    await cleanup?.("completed");
    expect(gatewayComputerStatusMock).toHaveBeenCalledOnce();
    expect(listNodesMock).toHaveBeenCalledOnce();
    expect(callGatewayToolMock.mock.calls.map(([method]) => method)).toEqual([
      "computer.invoke",
      "computer.invoke",
      "computer.invoke",
      "computer.invoke",
    ]);
    expect(
      callGatewayToolMock.mock.calls.every(
        (call) => call[2].generation === computerUse.provider.generation,
      ),
    ).toBe(true);
    expect(callGatewayToolMock.mock.calls.at(-1)?.[2]).toMatchObject({
      command: "computer.act",
      params: { action: "__close_execution" },
    });
  });

  it("unites both hosts' initial actions and keeps explicit node selection on the node", async () => {
    const gateway = v2Descriptor(["screenshot", "list_windows"]);
    const node = v2Descriptor(["screenshot", "get_cursor_position"]);
    gatewayComputerStatusMock.mockResolvedValue({
      configured: true,
      available: true,
      computerUse: gateway,
    });
    listNodesMock.mockResolvedValue([macComputerNode({ nodeId: "gateway", computerUse: node })]);
    const availability = await loadPairedComputerUseAvailabilityForSurface({
      computerAllowed: true,
    });
    const tool = createHostedComputerTool({ pairedNodeComputerUse: availability?.prepared });
    expect(readActionEnum(tool)).toEqual(
      expect.arrayContaining(["list_windows", "get_cursor_position"]),
    );
    const first = await tool.execute("node", { action: "screenshot", node: "gateway" });
    expect(first.details).toMatchObject({ node: "gateway" });
    const second = await tool.execute("sticky", { action: "screenshot" });
    expect(second.details).toMatchObject({ node: "gateway" });
    expect(callGatewayToolMock.mock.calls.every(([method]) => method === "node.invoke")).toBe(true);
    await expect(
      tool.execute("conflict", { action: "screenshot", target: "gateway", node: "gateway" }),
    ).rejects.toThrow("does not accept a node selector");
  });

  it("rejects a node frame on the Gateway even when the node is named gateway", async () => {
    gatewayComputerStatusMock.mockResolvedValue({
      configured: true,
      available: true,
      computerUse: v2Descriptor(["screenshot", "left_click"]),
    });
    listNodesMock.mockResolvedValue([macComputerNode({ nodeId: "gateway" })]);
    const tool = createHostedComputerTool();
    const nodeScreenshot = await tool.execute("node", { action: "screenshot", node: "gateway" });
    await expect(
      tool.execute("wrong-frame", {
        action: "left_click",
        target: "gateway",
        coordinate: [0, 0],
        frameId: readFrameId(nodeScreenshot),
      }),
    ).rejects.toThrow("no screenshot of this computer");
    expect(callGatewayToolMock).toHaveBeenCalledOnce();
    const gatewayScreenshot = await tool.execute("gateway", {
      action: "screenshot",
      target: "gateway",
    });
    await expect(
      tool.execute("wrong-node-frame", {
        action: "left_click",
        node: "gateway",
        coordinate: [0, 0],
        frameId: readFrameId(gatewayScreenshot),
      }),
    ).rejects.toThrow("no screenshot of this computer");
    expect(callGatewayToolMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "gateway"] as const)(
    "reports configured Gateway failure for target %s without selecting a node",
    async (target) => {
      gatewayComputerStatusMock.mockResolvedValue({
        configured: true,
        available: false,
        error: "Desktop session stopped",
      });
      const tool = createHostedComputerTool();
      await expect(tool.execute("observe", { action: "screenshot", target })).rejects.toThrow(
        "Desktop session stopped",
      );
      expect(listNodesMock).not.toHaveBeenCalled();
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed selected Gateway on its bound route", async () => {
    gatewayComputerStatusMock.mockResolvedValue({
      configured: true,
      available: true,
      computerUse: v2Descriptor(["screenshot", "type"]),
    });
    const tool = createHostedComputerTool();
    await tool.execute("observe", { action: "screenshot" });
    gatewayComputerStatusMock.mockResolvedValue({ configured: false, available: false });
    callGatewayToolMock.mockRejectedValue(new Error("Gateway computer disconnected"));
    await expect(tool.execute("input", { action: "type", text: "fixture" })).rejects.toThrow(
      "disconnected",
    );
    expect(gatewayComputerStatusMock).toHaveBeenCalledOnce();
    expect(listNodesMock).not.toHaveBeenCalled();
    expect(callGatewayToolMock.mock.calls.map(([method]) => method)).toEqual([
      "computer.invoke",
      "computer.invoke",
    ]);
  });

  it("recovers a retired Gateway on a fresh screenshot without retrying its input", async () => {
    const first = v2Descriptor(["screenshot", "left_click", "type"]);
    const second = v2Descriptor(["screenshot", "left_click", "type"], {
      provider: { ...first.provider, generation: "generation-2" },
    });
    gatewayComputerStatusMock
      .mockResolvedValueOnce({ configured: true, available: true, computerUse: first })
      .mockResolvedValue({ configured: true, available: true, computerUse: second });
    const availability = await loadPairedComputerUseAvailabilityForSurface({
      computerAllowed: true,
    });
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createHostedComputerTool({
      pairedNodeComputerUse: availability?.prepared,
      contextEpoch: { value: 0 },
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    let retired = false;
    callGatewayToolMock.mockImplementation(async (_method, _options, request) => {
      if (request.params.action === "__close_execution") {
        return { payload: { ok: true } };
      }
      if (request.generation === first.provider.generation && retired) {
        throw new Error("Error: COMPUTER_STALE_OBSERVATION: Gateway computer generation changed");
      }
      return request.command === "screen.snapshot"
        ? screenshotPayload()
        : { payload: { ok: true } };
    });
    const before = await tool.execute("before", { action: "screenshot" });
    retired = true;
    await expect(tool.execute("input", { action: "type", text: "fixture" })).rejects.toThrow(
      "COMPUTER_STALE_OBSERVATION",
    );
    expect(gatewayComputerStatusMock).toHaveBeenCalledOnce();
    expect(
      callGatewayToolMock.mock.calls.filter((call) => call[2].params.action === "type"),
    ).toHaveLength(1);
    const after = await tool.execute("recover", { action: "screenshot" });
    expect(gatewayComputerStatusMock).toHaveBeenCalledTimes(2);
    expect(readFrameId(after)).not.toBe(readFrameId(before));
    expect(after.content.some((part) => part.type === "image")).toBe(true);
    await expect(
      tool.execute("old-frame", {
        action: "left_click",
        coordinate: [0, 0],
        frameId: readFrameId(before),
      }),
    ).rejects.toThrow("frameId does not match");
    await tool.execute("fresh-input", {
      action: "left_click",
      coordinate: [0, 0],
      frameId: readFrameId(after),
    });
    await cleanup?.("completed");
    expect(
      callGatewayToolMock.mock.calls.filter((call) => call[2].params.action === "left_click"),
    ).toHaveLength(1);
    expect(
      callGatewayToolMock.mock.calls
        .filter((call) => call[2].params.action === "__close_execution")
        .map((call) => call[2].generation)
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([first.provider.generation, second.provider.generation]);
    expect(listNodesMock).toHaveBeenCalledOnce();
  });

  it.each(["gateway", "node"] as const)(
    "bounds stale screenshot recovery on %s",
    async (target) => {
      gatewayComputerStatusMock.mockResolvedValue({
        configured: true,
        available: true,
        computerUse: v2Descriptor(["screenshot"]),
      });
      callGatewayToolMock.mockRejectedValue(
        new Error("COMPUTER_STALE_OBSERVATION: native capture retired"),
      );
      const tool = createHostedComputerTool();
      await expect(tool.execute("observe", { action: "screenshot", target })).rejects.toThrow(
        "COMPUTER_STALE_OBSERVATION",
      );
      expect(callGatewayToolMock).toHaveBeenCalledTimes(target === "gateway" ? 2 : 1);
      expect(gatewayComputerStatusMock).toHaveBeenCalledTimes(target === "gateway" ? 2 : 0);
      expect(listNodesMock).toHaveBeenCalledTimes(target === "gateway" ? 0 : 1);
    },
  );

  it("surfaces Gateway cleanup failure without dropping execution cleanup", async () => {
    gatewayComputerStatusMock.mockResolvedValue({
      configured: true,
      available: true,
      computerUse: v2Descriptor(["screenshot"]),
    });
    let cleanup: ((reason: string) => Promise<void>) | undefined;
    const tool = createHostedComputerTool({
      registerRunCleanup: (registered) => {
        cleanup = registered;
      },
    });
    callGatewayToolMock.mockResolvedValueOnce(screenshotPayload());
    await tool.execute("observe", { action: "screenshot" });
    callGatewayToolMock.mockRejectedValue(new Error("cleanup failed"));
    await expect(cleanup?.("completed")).rejects.toThrow("desktop cleanup failed");
  });
});
