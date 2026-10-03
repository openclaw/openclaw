import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../../test-utils/gateway-scheduler-clock.js";
import { createGatewayConnectionState } from "../../server-connection-state.js";
import type { GatewayRequestOptions } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

const runtime = vi.hoisted(() => ({ beforeHandler: vi.fn<() => Promise<void>>() }));

vi.mock("./authenticated-request-dispatch.server-methods.runtime.js", async () => {
  const { sessionSubscriptionHandlers } =
    await import("../../server-methods/sessions-subscriptions.js");
  const { sessionObserverHandlers } = await import("../../session-observer-rpc.js");
  return {
    handleGatewayRequest: async (options: GatewayRequestOptions) => {
      await runtime.beforeHandler();
      const handler =
        sessionSubscriptionHandlers[options.req.method] ??
        sessionObserverHandlers[options.req.method];
      if (!handler) {
        throw new Error(`missing test handler for ${options.req.method}`);
      }
      await handler({
        ...options,
        params: (options.req.params ?? {}) as Record<string, unknown>,
      });
    },
  };
});

describe("authenticated request connection liveness", { concurrent: false }, () => {
  beforeEach(() => {
    runtime.beforeHandler.mockReset();
  });

  it.each([
    {
      method: "sessions.subscribe",
      params: {},
      expectedResponse: { ok: true },
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) =>
        expect(state.sessionEventSubscribers.getAll()).toEqual(new Set()),
    },
    {
      method: "sessions.messages.subscribe",
      params: { key: "agent:main:main" },
      expectedResponse: { ok: true },
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) =>
        expect(state.sessionMessageSubscribers.get("agent:main:main")).toEqual(new Set()),
    },
    {
      method: "sessions.observer.visibility",
      params: { visible: true },
      expectedResponse: { ok: false, error: { code: "FORBIDDEN" } },
      assertEmpty: (
        _state: ReturnType<typeof createGatewayConnectionState>,
        setConnectionVisibility: ReturnType<typeof vi.fn>,
      ) => expect(setConnectionVisibility).not.toHaveBeenCalled(),
    },
  ])("rejects a late $method mutation after disconnect cleanup", async (testCase) => {
    const held = createDeferredCore();
    const started = createDeferredCore();
    runtime.beforeHandler.mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const state = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "late-subscription",
      cfg: {},
    });
    onTestFinished(() => state.mentionInbox.dispose());
    const client = createOperatorWsClient({
      connId: "late-subscription-connection",
      scopes: ["operator.read"],
    });
    state.clients.add(client);
    const setConnectionVisibility = vi.fn();
    const harness = createDispatchTestHarness({
      connId: client.connId,
      buildRequestContext: () => ({
        getRuntimeConfig: () => ({}),
        logGateway: { error: vi.fn() },
        subscribeSessionEvents: state.sessionEventSubscribers.subscribe,
        subscribeSessionMessageEvents: state.sessionMessageSubscribers.subscribe,
        isConnectionActive: state.isConnectionActive,
        sessionObserver: { setConnectionVisibility },
      }),
    });

    const dispatch = harness.dispatcher.dispatch(
      { type: "req", id: testCase.method, method: testCase.method, params: testCase.params },
      client,
    );
    try {
      await started.promise;
      expect(runtime.beforeHandler).toHaveBeenCalledOnce();
      state.clients.delete(client);
      state.sessionEventSubscribers.unsubscribe(client.connId);
      state.sessionMessageSubscribers.unsubscribeAll(client.connId);
    } finally {
      held.resolve();
      await dispatch;
    }

    expect(await harness.awaitResponseFrame(testCase.method)).toMatchObject(
      testCase.expectedResponse,
    );
    testCase.assertEmpty(state, setConnectionVisibility);
  });
});
