// Register shared mocks before loading the handlers they replace.
import "./nodes.invoke-wake-mocks.test-support.js";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as nodeInvokePluginPolicy from "../node-invoke-plugin-policy.js";
import {
  captureNodeWakeLifecycle,
  isNodeWakeLifecycleCurrent,
  releaseNodeWakeLifecycle,
} from "../node-wake-state.js";
import {
  createMissingNodeRegistry,
  DIRECT_APNS_RESULT,
  installNodeInvokeWakeFixture,
  invokeNode,
  mockDirectWakeConfig,
  mocks,
} from "./nodes.invoke-wake.test-support.js";
import { firstRespondCall, type TestNodeSession } from "./nodes.invoke.test-support.js";
import * as nodePairingWork from "./nodes.shared.js";
import * as nodeWake from "./nodes.wake.js";

function expectInvokeTimeout(respond: Parameters<typeof firstRespondCall>[0]) {
  expect(firstRespondCall(respond)).toMatchObject([
    false,
    undefined,
    { message: "TIMEOUT: node invoke timed out", details: { nodeError: { code: "TIMEOUT" } } },
  ]);
}

describe("node.invoke admission deadlines", () => {
  installNodeInvokeWakeFixture();

  it("stops waking an offline node when the invoke deadline expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const nodeId = "ios-node-short-invoke-deadline";
    mockDirectWakeConfig(nodeId);
    const nodeRegistry = createMissingNodeRegistry();

    const pending = invokeNode({
      nodeRegistry,
      requestParams: { nodeId, idempotencyKey: "idem-short-invoke-deadline", timeoutMs: 100 },
    });

    await vi.advanceTimersByTimeAsync(100);

    expectInvokeTimeout(await pending);
    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    expect(mocks.sendApnsAlert).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("times out when initial node pairing capture remains in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const nodeId = "ios-node-stalled-pairing-capture";
    const capture = createDeferred<{ nodeId: string; key: string }>();
    mocks.captureNodePairingGeneration.mockReturnValue(capture.promise);
    const nodeRegistry = createMissingNodeRegistry();

    const pending = invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId,
        idempotencyKey: "idem-stalled-pairing-capture",
        timeoutMs: 100,
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(100);

      const respond = await pending;
      expectInvokeTimeout(respond);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();

      capture.resolve({ nodeId, key: `generation:${nodeId}:1` });
      await capture.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(respond).toHaveBeenCalledOnce();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
    } finally {
      capture.resolve({ nodeId, key: `generation:${nodeId}:1` });
      await Promise.allSettled([capture.promise, pending]);
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("times out when a node pairing recheck remains in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const nodeId = "ios-node-stalled-pairing-recheck";
    const pairing = createDeferred<boolean>();
    mocks.isNodePairingGenerationCurrent.mockReturnValue(pairing.promise);
    const pairingWork = vi.spyOn(nodePairingWork, "withCurrentNodePairingWork");
    const session: TestNodeSession = {
      nodeId,
      connId: "stalled-pairing-conn",
      commands: ["camera.capture"],
      platform: "iOS 26.4.0",
    };
    const nodeRegistry = {
      get: vi.fn(() => session),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const pending = invokeNode({
      nodeRegistry,
      requestParams: { nodeId, idempotencyKey: "idem-stalled-pairing-recheck", timeoutMs: 100 },
    });

    try {
      await vi.advanceTimersByTimeAsync(100);

      const respond = await pending;
      expectInvokeTimeout(respond);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();

      pairing.resolve(true);
      await Promise.all(
        pairingWork.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
      expect(respond).toHaveBeenCalledOnce();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    } finally {
      pairing.resolve(true);
      await Promise.allSettled([
        pairing.promise,
        pending,
        ...pairingWork.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      ]);
      pairingWork.mockRestore();
    }
  });

  it("preserves dispatched plugin work when its pairing recheck times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const nodeId = "ios-node-dispatched-plugin-pairing-timeout";
    const generation = `generation:${nodeId}:1`;
    // Another caller keeps the shared wake owner live, so only the deadline
    // can suppress the delayed response after this invocation releases its claim.
    const retainedWake = captureNodeWakeLifecycle(nodeId, generation);
    const pairing = createDeferred<boolean>();
    mocks.isNodePairingGenerationCurrent.mockReturnValue(pairing.promise);
    const pairingWork = vi.spyOn(nodePairingWork, "withCurrentNodePairingWork");
    const session: TestNodeSession = {
      nodeId,
      connId: "dispatched-plugin-conn",
      commands: ["camera.capture"],
      platform: "iOS 26.4.0",
    };
    const nodeRegistry = {
      get: vi.fn(() => session),
      invoke: vi.fn().mockResolvedValue({ ok: true, payload: { ok: true }, payloadJSON: null }),
    };
    const applyPolicy = vi
      .spyOn(nodeInvokePluginPolicy, "applyPluginNodeInvokePolicy")
      .mockImplementation(async (params) => {
        params.onNodeCommandDispatched?.();
        await params.context.nodeRegistry.invoke({
          nodeId: params.nodeSession.nodeId,
          expectedConnId: params.nodeSession.connId,
          command: params.command,
          params: params.params,
          timeoutMs: params.timeoutMs,
          idempotencyKey: params.idempotencyKey,
        });
        return { ok: true, payload: { ok: true }, payloadJSON: null };
      });
    const pending = invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId,
        idempotencyKey: "idem-dispatched-plugin-pairing-timeout",
        timeoutMs: 100,
      },
    });

    try {
      await vi.advanceTimersByTimeAsync(100);

      const respond = await pending;
      expect(firstRespondCall(respond)).toMatchObject([
        false,
        undefined,
        {
          message: "TIMEOUT: node invoke timed out",
          details: {
            nodeError: { code: "TIMEOUT" },
            nodeCommandDispatched: true,
          },
        },
      ]);
      expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
      expect(isNodeWakeLifecycleCurrent(nodeId, retainedWake, generation)).toBe(true);

      pairing.resolve(true);
      await Promise.all(
        pairingWork.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      );
      expect(respond).toHaveBeenCalledOnce();
      expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
      expect(isNodeWakeLifecycleCurrent(nodeId, retainedWake, generation)).toBe(true);
    } finally {
      pairing.resolve(true);
      await Promise.allSettled([
        pairing.promise,
        pending,
        ...pairingWork.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
        ...applyPolicy.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        ),
      ]);
      releaseNodeWakeLifecycle(nodeId, retainedWake);
      pairingWork.mockRestore();
      applyPolicy.mockRestore();
    }
  });

  it.each([100, MAX_TIMER_TIMEOUT_MS + 100])(
    "bounds a pending APNs wake to the %i ms invoke budget",
    async (timeoutMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const nodeId = "pending-apns";
      mockDirectWakeConfig(nodeId);
      const wake = createDeferred<typeof DIRECT_APNS_RESULT>();
      mocks.sendApnsBackgroundWake.mockReturnValue(wake.promise);
      const nodeRegistry = createMissingNodeRegistry();
      let settled = false;
      const pending = invokeNode({ nodeRegistry, requestParams: { nodeId, timeoutMs } });
      void pending.then(() => {
        settled = true;
      });
      try {
        if (timeoutMs > MAX_TIMER_TIMEOUT_MS) {
          await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
          expect(settled).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(100);
        expectInvokeTimeout(await pending);
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
        expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledOnce();
      } finally {
        wake.resolve(DIRECT_APNS_RESULT);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("rejects wake results that resolve after the absolute invoke deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const nodeId = "ios-node-late-apns-wake-result";
    mockDirectWakeConfig(nodeId);
    mocks.sendApnsBackgroundWake.mockImplementation(async () => {
      now = 101;
      vi.setSystemTime(101);
      return DIRECT_APNS_RESULT;
    });
    const nodeRegistry = createMissingNodeRegistry();

    try {
      const respond = await invokeNode({
        nodeRegistry,
        requestParams: { nodeId, idempotencyKey: "idem-late-apns-wake-result", timeoutMs: 100 },
      });

      expectInvokeTimeout(respond);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("does not treat a pairing checkpoint as a completed response after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let now = 0;
    let nudged = false;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    mocks.loadApnsRegistration.mockResolvedValue(null);
    const nudge = nodeWake.maybeSendNodeWakeNudge;
    const nudgeSpy = vi
      .spyOn(nodeWake, "maybeSendNodeWakeNudge")
      .mockImplementation(async (...args) => {
        const result = await nudge(...args);
        nudged = true;
        return result;
      });
    const pairingWork = nodePairingWork.withCurrentNodePairingWork;
    const pairingSpy = vi
      .spyOn(nodePairingWork, "withCurrentNodePairingWork")
      .mockImplementation(async (params, start) => {
        const result = await pairingWork(params, start);
        if (nudged) {
          now = 101;
          vi.setSystemTime(101);
        }
        return result;
      });
    const nodeRegistry = createMissingNodeRegistry();
    try {
      const respond = await invokeNode({
        nodeRegistry,
        requestParams: { nodeId: "offline-checkpoint", timeoutMs: 100 },
      });
      expect(nudgeSpy).toHaveBeenCalledOnce();
      expectInvokeTimeout(respond);
      expect(respond).toHaveBeenCalledOnce();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    } finally {
      pairingSpy.mockRestore();
      nudgeSpy.mockRestore();
      clock.mockRestore();
    }
  });
});
