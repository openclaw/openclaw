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
const address = { agentId: "main", sessionKey: "agent:main:main" };
const system = () => createRuntimeBase().system;
const captureTarget = () => system().captureSessionEventTarget(address.agentId, address.sessionKey);
let active: boolean;
const inOwnerScope = <T>(run: () => T) =>
  withPluginRuntimeGatewayRequestScope(
    {
      isWebchatConnect: () => false,
      assertSystemOwnerCurrent: () => {
        if (!active) {
          throw new Error("retired owner");
        }
      },
    },
    run,
  );

beforeEach(() => {
  vi.clearAllMocks();
  active = true;
  host.capture.mockResolvedValue(target);
});

describe("plugin session-event boundary", () => {
  it("forwards only public fields and fixes the event source", async () => {
    const expectedTarget = await captureTarget();
    expect(Object.isFrozen(expectedTarget)).toBe(true);
    expect(Object.keys(expectedTarget)).toEqual([]);
    const publicOptions = {
      ...address,
      contextKey: "plugin:notice",
      deliveryContext: { channel: "discord", to: "channel:123" },
      abortSignal: new AbortController().signal,
      createIfMissing: true as const,
    };
    const options = {
      ...publicOptions,
      expectedTarget,
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
    expect(system().enqueueSessionEvent("Completed", options)).toBe(receipt);
    expect(host.enqueue).toHaveBeenCalledExactlyOnceWith("Completed", {
      ...publicOptions,
      expectedTarget: target,
      source: "plugin",
    });
  });

  it("redeems handles across runtime copies and rejects copied handles", async () => {
    const expectedTarget = await captureTarget();
    vi.resetModules();
    const { createRuntimeBase: createDuplicate } = await import("./runtime-base.js");
    createDuplicate().system.enqueueSessionEvent("Completed", {
      ...address,
      expectedTarget,
    });
    expect(host.enqueue.mock.calls[0]?.[1].expectedTarget).toBe(target);
    host.enqueue.mockClear();
    for (const copied of [structuredClone(expectedTarget), { ...expectedTarget }]) {
      expect(() =>
        system().enqueueSessionEvent("Completed", { ...address, expectedTarget: copied }),
      ).toThrow("not captured by this runtime");
    }
    expect(host.enqueue).not.toHaveBeenCalled();
  });

  it("rejects capture when its owner retires during host preparation", async () => {
    const pending = createDeferredCore<SessionEventTarget>();
    host.capture.mockReturnValueOnce(pending.promise);
    const capture = inOwnerScope(captureTarget);
    active = false;
    pending.resolve(target);
    await expect(capture).rejects.toThrow("retired owner");
  });

  it("keeps the admitted owner assertion on host event effects", () => {
    inOwnerScope(() => system().enqueueSessionEvent("Completed", address));
    const forwarded = host.enqueue.mock.calls[0]?.[1] as SessionEventOptions;
    active = false;
    expect(() => forwarded.assertCurrent?.()).toThrow("retired owner");
  });
});
