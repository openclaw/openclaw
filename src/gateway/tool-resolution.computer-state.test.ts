import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const listNodesMock = vi.fn();
const callGatewayToolMock = vi.fn();
const sleepMock = vi.hoisted(() => vi.fn());
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

vi.mock("../agents/tools/nodes-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/tools/nodes-utils.js")>();
  return { ...actual, listNodes: listNodesMock };
});

vi.mock("../agents/tools/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/tools/gateway.js")>();
  return { ...actual, callGatewayTool: callGatewayToolMock };
});

vi.mock("../agents/utils/sleep.js", () => ({ sleep: sleepMock }));

const { resolveComputerInvocationState, resolveGatewayScopedTools } =
  await import("./tool-resolution.js");

function macComputerNode(nodeId: string) {
  return {
    nodeId,
    displayName: nodeId,
    platform: "macos",
    connected: true,
    commands: ["screen.snapshot", "computer.act"],
  };
}

function screenshotPayload() {
  return {
    payload: {
      format: "png",
      base64: TINY_PNG_BASE64,
      displayFrameId: "display-0-frame",
      width: 1280,
      height: 800,
      screenIndex: 0,
    },
  };
}

function dispatchedComputerActions(): Array<{ nodeId: unknown; action: unknown }> {
  return callGatewayToolMock.mock.calls
    .filter((call) => (call[2] as { command?: string }).command === "computer.act")
    .map((call) => {
      const body = call[2] as { nodeId?: unknown; params?: { action?: unknown } };
      return { nodeId: body.nodeId, action: body.params?.action };
    });
}

function resolveComputerTool(sessionKey: string) {
  const result = resolveGatewayScopedTools({
    cfg: { gateway: { tools: { allow: ["computer"] } } } as OpenClawConfig,
    sessionKey,
    surface: "http",
    senderIsOwner: true,
  });
  const tool = result.tools.find((candidate) => candidate.name === "computer");
  if (!tool?.execute) {
    throw new Error("computer tool not resolved");
  }
  return tool;
}

describe("gateway computer invocation state", () => {
  beforeEach(() => {
    listNodesMock.mockReset();
    callGatewayToolMock.mockReset();
    sleepMock.mockReset();
    listNodesMock.mockResolvedValue([macComputerNode("mac-a"), macComputerNode("mac-b")]);
    callGatewayToolMock.mockResolvedValue(screenshotPayload());
    sleepMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks a held-button cross-node retarget across per-call tool rebuilds", async () => {
    const sessionKey = "agent:main:computer-guard";
    const downTool = resolveComputerTool(sessionKey);
    await downTool.execute("down", { action: "left_mouse_down", node: "mac-a" });

    const retargetTool = resolveComputerTool(sessionKey);
    expect(retargetTool).not.toBe(downTool);
    await expect(
      retargetTool.execute("retarget", { action: "left_mouse_down", node: "mac-b" }),
    ).rejects.toThrow(/left button may still be held on node mac-a/);
    expect(dispatchedComputerActions()).toEqual([{ nodeId: "mac-a", action: "left_mouse_down" }]);

    await resolveComputerTool(sessionKey).execute("up", { action: "left_mouse_up" });
    await expect(
      resolveComputerTool(sessionKey).execute("retarget-after-release", {
        action: "left_mouse_down",
        node: "mac-b",
      }),
    ).resolves.toBeDefined();
    expect(dispatchedComputerActions()).toEqual([
      { nodeId: "mac-a", action: "left_mouse_down" },
      { nodeId: "mac-a", action: "left_mouse_up" },
      { nodeId: "mac-b", action: "left_mouse_down" },
    ]);
  });

  it("keeps held-button state isolated between session keys", async () => {
    await resolveComputerTool("agent:main:computer-iso-a").execute("down", {
      action: "left_mouse_down",
      node: "mac-a",
    });

    await expect(
      resolveComputerTool("agent:main:computer-iso-b").execute("other-session", {
        action: "left_mouse_down",
        node: "mac-b",
      }),
    ).resolves.toBeDefined();
  });

  it("reuses session state within the ttl and expires it once idle past the ttl", () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:computer-ttl";
    const first = resolveComputerInvocationState(sessionKey);

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(resolveComputerInvocationState(sessionKey)).toBe(first);

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(resolveComputerInvocationState(sessionKey)).toBe(first);

    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(resolveComputerInvocationState(sessionKey)).not.toBe(first);
  });

  it("evicts the least recently touched session state beyond the cap", () => {
    const first = resolveComputerInvocationState("agent:main:computer-evict-0");
    for (let index = 1; index <= 64; index += 1) {
      resolveComputerInvocationState(`agent:main:computer-evict-${index}`);
    }
    expect(resolveComputerInvocationState("agent:main:computer-evict-0")).not.toBe(first);
  });
});
