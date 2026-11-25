import { expect, it, onTestFinished, vi } from "vitest";
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

it.each(["sessions.subscribe", "sessions.messages.subscribe", "sessions.observer.visibility"])(
  "rejects a late %s mutation after disconnect cleanup",
  { concurrent: false },
  async (method) => {
    const visibility = method === "sessions.observer.visibility";
    const messages = method === "sessions.messages.subscribe";
    const params = visibility ? { visible: true } : messages ? { key: "agent:main:main" } : {};
    const held = createDeferredCore();
    const started = createDeferredCore();
    runtime.beforeHandler.mockReset().mockImplementation(() => {
      started.resolve();
      return held.promise;
    });
    const scheduler = createTestGatewayScheduler();
    const state = createGatewayConnectionState({ scheduler, bootId: "late", cfg: {} });
    onTestFinished(() => state.mentionInbox.dispose());
    const client = createOperatorWsClient({ scopes: ["operator.read"] });
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
    const run = harness.dispatcher.dispatch({ type: "req", id: method, method, params }, client);
    try {
      await started.promise;
      expect(runtime.beforeHandler).toHaveBeenCalledOnce();
      state.clients.delete(client);
      state.sessionEventSubscribers.unsubscribe(client.connId);
      state.sessionMessageSubscribers.unsubscribeAll(client.connId);
    } finally {
      held.resolve();
      await run;
    }
    expect(await harness.awaitResponseFrame(method)).toMatchObject(
      visibility ? { ok: false, error: { code: "FORBIDDEN" } } : { ok: true },
    );
    expect([
      state.sessionEventSubscribers.getAll(),
      state.sessionMessageSubscribers.get("agent:main:main"),
      setConnectionVisibility.mock.calls,
    ]).toEqual([new Set(), new Set(), []]);
  },
);
