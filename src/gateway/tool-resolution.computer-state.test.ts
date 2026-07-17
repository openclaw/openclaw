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

const { resolveGatewayScopedTools } = await import("./tool-resolution.js");

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

  it("keeps a held button guarded past the ttl and expires only released idle state", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sessionKey = "agent:main:computer-ttl";
    await resolveComputerTool(sessionKey).execute("down", {
      action: "left_mouse_down",
      node: "mac-a",
    });

    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await expect(
      resolveComputerTool(sessionKey).execute("still-held", {
        action: "left_mouse_down",
        node: "mac-b",
      }),
    ).rejects.toThrow(/left button may still be held on node mac-a/);

    await resolveComputerTool(sessionKey).execute("up", { action: "left_mouse_up" });
    await expect(
      resolveComputerTool(sessionKey).execute("affinity", { action: "screenshot" }),
    ).resolves.toMatchObject({ details: { node: "mac-a" } });

    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await expect(
      resolveComputerTool(sessionKey).execute("after-idle-expiry", { action: "screenshot" }),
    ).rejects.toThrow(/multiple computer-capable nodes connected/);
  });

  it("keeps a held button guarded under session-cap pressure", async () => {
    const sessionKey = "agent:main:computer-evict";
    await resolveComputerTool(sessionKey).execute("down", {
      action: "left_mouse_down",
      node: "mac-a",
    });

    for (let index = 0; index < 64; index += 1) {
      await resolveComputerTool(`agent:main:computer-evict-filler-${index}`).execute(
        `filler-${index}`,
        { action: "screenshot", node: "mac-b" },
      );
    }

    await expect(
      resolveComputerTool(sessionKey).execute("after-cap-pressure", {
        action: "left_mouse_down",
        node: "mac-b",
      }),
    ).rejects.toThrow(/left button may still be held on node mac-a/);

    await resolveComputerTool(sessionKey).execute("up", { action: "left_mouse_up" });
    await expect(
      resolveComputerTool(sessionKey).execute("after-release", {
        action: "left_mouse_down",
        node: "mac-b",
      }),
    ).resolves.toBeDefined();
  });

  it("keeps in-flight input on the session queue across rebuilds and ttl pressure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sessionKey = "agent:main:computer-inflight";
    let releaseDown = () => {};
    const downGate = new Promise<void>((resolve) => {
      releaseDown = resolve;
    });
    callGatewayToolMock.mockImplementation(async (_method, _opts, body) => {
      const request = body as { command?: string; params?: { action?: string } };
      if (request.command === "computer.act" && request.params?.action === "left_mouse_down") {
        await downGate;
      }
      return screenshotPayload();
    });

    const downPromise = resolveComputerTool(sessionKey).execute("down", {
      action: "left_mouse_down",
      node: "mac-a",
    });
    await vi.waitFor(() => {
      expect(dispatchedComputerActions()).toEqual([{ nodeId: "mac-a", action: "left_mouse_down" }]);
    });

    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    const retargetPromise = resolveComputerTool(sessionKey).execute("retarget", {
      action: "left_mouse_down",
      node: "mac-b",
    });
    releaseDown();

    await expect(downPromise).resolves.toBeDefined();
    await expect(retargetPromise).rejects.toThrow(/left button may still be held on node mac-a/);
    expect(dispatchedComputerActions()).toEqual([{ nodeId: "mac-a", action: "left_mouse_down" }]);
  });

  it("fails closed for a new session when every tracked session is pinned", async () => {
    let limitError: unknown;
    for (let index = 0; index < 80; index += 1) {
      try {
        await resolveComputerTool(`agent:main:computer-full-${index}`).execute(`full-${index}`, {
          action: "left_mouse_down",
          node: "mac-a",
        });
      } catch (err) {
        limitError = err;
        break;
      }
    }
    expect(String(limitError)).toMatch(/too many sessions with a held button or in-flight input/);

    await expect(
      resolveComputerTool("agent:main:computer-full-overflow").execute("overflow", {
        action: "left_mouse_down",
        node: "mac-a",
      }),
    ).rejects.toThrow(/too many sessions with a held button or in-flight input/);

    await resolveComputerTool("agent:main:computer-full-0").execute("release-one", {
      action: "left_mouse_up",
    });
    await expect(
      resolveComputerTool("agent:main:computer-full-overflow").execute("overflow-after-release", {
        action: "left_mouse_down",
        node: "mac-a",
      }),
    ).resolves.toBeDefined();
  });
});
