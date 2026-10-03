import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { createRuntimeSystem } from "./runtime-system.js";

const { captureSessionEventTarget, enqueueSessionEvent } = createRuntimeSystem();

const host = vi.hoisted(() => ({
  capture: vi.fn(async () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "original",
    generation: "process",
  })),
  enqueue: vi.fn(),
}));
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: host.capture,
  enqueueSessionEventForHost: host.enqueue,
}));
beforeEach(() => {
  vi.clearAllMocks();
  host.capture.mockImplementation(async () => ({
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "original",
    generation: "process",
  }));
});

describe("plugin session-event boundary", () => {
  it("carries only host-captured target facts and public fields", async () => {
    const expectedTarget = await captureSessionEventTarget("main", "agent:main:main");
    const options = {
      agentId: "main",
      sessionKey: "agent:main:main",
      expectedTarget,
      source: "cron",
      scheduledAutomation: { assertCurrent: vi.fn() },
      onAdopted: vi.fn(),
      occurrence: { id: "forged" },
      deliver: false,
    };
    enqueueSessionEvent("Completed", options);
    expect(host.enqueue).toHaveBeenCalledExactlyOnceWith("Completed", {
      agentId: "main",
      sessionKey: "agent:main:main",
      source: "plugin",
      expectedTarget: await host.capture.mock.results[0]!.value,
      contextKey: undefined,
      deliveryContext: undefined,
      abortSignal: undefined,
    });
  });
  it("accepts the original handle across duplicated runtime module instances", async () => {
    const expectedTarget = await captureSessionEventTarget("main", "agent:main:main");
    vi.resetModules();
    const duplicate = await import("./runtime-system.js");
    duplicate.createRuntimeSystem().enqueueSessionEvent("Completed", {
      agentId: "main",
      sessionKey: "agent:main:main",
      expectedTarget,
    });
    expect(host.enqueue).toHaveBeenCalledExactlyOnceWith(
      "Completed",
      expect.objectContaining({ expectedTarget: await host.capture.mock.results[0]!.value }),
    );
  });
  it("rejects copied or fabricated handles instead of recapturing the successor session", async () => {
    const original = await captureSessionEventTarget("main", "agent:main:main");
    for (const expectedTarget of [structuredClone(original), { ...original }]) {
      expect(() =>
        enqueueSessionEvent("Completed", {
          agentId: "main",
          sessionKey: "agent:main:main",
          expectedTarget,
        }),
      ).toThrow("not captured by this runtime");
    }
    expect(host.enqueue).not.toHaveBeenCalled();
    expect(host.capture).toHaveBeenCalledTimes(1);
  });
  it("rejects a target capture whose plugin owner retires while the row is read", async () => {
    let retire = false;
    host.capture.mockImplementationOnce(async () => {
      retire = true;
      return {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "original",
        generation: "process",
      };
    });
    const result = withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        assertSystemOwnerCurrent: () => {
          if (retire) {
            throw new Error("retired owner");
          }
        },
      },
      () => captureSessionEventTarget("main", "agent:main:main"),
    );
    await expect(result).rejects.toThrow("retired owner");
    expect(host.enqueue).not.toHaveBeenCalled();
  });
});
