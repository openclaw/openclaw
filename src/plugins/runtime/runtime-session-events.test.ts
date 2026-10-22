import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionEventOptions,
  SessionEventTarget,
} from "../../auto-reply/reply/session-event-contract.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import { createRuntimeBase } from "./runtime-base.js";

const host = vi.hoisted(() => ({
  capture: vi.fn<(...args: unknown[]) => Promise<SessionEventTarget>>(),
  enqueue: vi.fn(),
}));
// mock-isolation: Verify the public adapter contract without admitting model work or reading live sessions.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: host.capture,
  enqueueSessionEventForHost: host.enqueue,
}));

const target: SessionEventTarget = {
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId: "original",
  generation: "process",
};

beforeEach(() => {
  vi.clearAllMocks();
  host.capture.mockResolvedValue(target);
});

describe("plugin session-event boundary", () => {
  it("forwards only public fields and fixes the event source", async () => {
    const system = createRuntimeBase().system;
    const expectedTarget = await system.captureSessionEventTarget("main", "agent:main:main");
    expect(Object.isFrozen(expectedTarget)).toBe(true);
    expect(Object.keys(expectedTarget)).toEqual([]);
    const abortSignal = new AbortController().signal;
    const deliveryContext = { channel: "discord", to: "channel:123" };
    const options = {
      agentId: "main",
      sessionKey: "agent:main:main",
      contextKey: "plugin:notice",
      deliveryContext,
      abortSignal,
      expectedTarget,
      createIfMissing: true as const,
      source: "cron",
      cfg: {},
      deps: {},
      scheduledAutomation: { assertCurrent: vi.fn() },
      onAdopted: vi.fn(),
      occurrences: [{ id: "forged" }],
      deliver: false,
    };
    const receipt = { id: "host-receipt" };
    host.enqueue.mockReturnValueOnce(receipt);
    expect(system.enqueueSessionEvent("Completed", options)).toBe(receipt);
    expect(host.enqueue).toHaveBeenCalledExactlyOnceWith("Completed", {
      agentId: "main",
      sessionKey: "agent:main:main",
      contextKey: "plugin:notice",
      deliveryContext,
      abortSignal,
      expectedTarget: target,
      createIfMissing: true,
      source: "plugin",
    });
  });

  it("redeems handles across runtime copies and rejects copied handles", async () => {
    const system = createRuntimeBase().system;
    const expectedTarget = await system.captureSessionEventTarget("main", "agent:main:main");
    vi.resetModules();
    const { createRuntimeBase: createDuplicate } = await import("./runtime-base.js");
    createDuplicate().system.enqueueSessionEvent("Completed", {
      agentId: "main",
      sessionKey: "agent:main:main",
      expectedTarget,
    });
    expect(host.enqueue.mock.calls[0]?.[1].expectedTarget).toBe(target);
    host.enqueue.mockClear();
    for (const copied of [structuredClone(expectedTarget), { ...expectedTarget }]) {
      expect(() =>
        system.enqueueSessionEvent("Completed", {
          agentId: "main",
          sessionKey: "agent:main:main",
          expectedTarget: copied,
        }),
      ).toThrow("not captured by this runtime");
    }
    expect(host.enqueue).not.toHaveBeenCalled();
    expect(host.capture).toHaveBeenCalledTimes(1);
  });

  it("rejects capture when its owner retires during host preparation", async () => {
    const pending = createDeferredCore<SessionEventTarget>();
    host.capture.mockReturnValueOnce(pending.promise);
    let active = true;
    const capture = withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        assertSystemOwnerCurrent: () => {
          if (!active) {
            throw new Error("retired owner");
          }
        },
      },
      () => createRuntimeBase().system.captureSessionEventTarget("main", "agent:main:main"),
    );
    active = false;
    pending.resolve(target);
    await expect(capture).rejects.toThrow("retired owner");
  });

  it("keeps the admitted owner assertion on host event effects", () => {
    let active = true;
    withPluginRuntimeGatewayRequestScope(
      {
        isWebchatConnect: () => false,
        assertSystemOwnerCurrent: () => {
          if (!active) {
            throw new Error("retired owner");
          }
        },
      },
      () =>
        createRuntimeBase().system.enqueueSessionEvent("Completed", {
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
    );
    const forwarded = host.enqueue.mock.calls[0]?.[1] as SessionEventOptions;
    expect(forwarded.assertCurrent).toBeTypeOf("function");
    active = false;
    expect(() => forwarded.assertCurrent?.()).toThrow("retired owner");
  });
});
