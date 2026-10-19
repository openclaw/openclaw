import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlUiDisposer } from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../app/gateway-store.test-support.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { type ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";

describe("plugin session message body admission", () => {
  let store: ReturnType<typeof createGatewayStoreTestStore>;
  const disposers: ControlUiDisposer[] = [];

  beforeEach(() => {
    stubGatewayStoreTestGlobals();
    store = createGatewayStoreTestStore();
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) {
      dispose();
    }
    store.gateway.stop();
    vi.unstubAllGlobals();
  });

  function host(pluginId: string) {
    // SAFETY: This fixture supplies the ownership fields used by onEvent only.
    const owner = {
      abort: new AbortController(),
      descriptor: { pluginId },
      disposers: new Set<ControlUiDisposer>(),
    } as Omit<ControlUiPluginOwner, "host">;
    // SAFETY: This host path reads only the real gateway owner from context.
    const getContext = () => ({ gateway: store.gateway }) as ApplicationContext;
    const runtime = new ControlUiPluginRuntime(getContext);
    vi.spyOn(runtime, "isCurrent").mockImplementation(() => !owner.abort.signal.aborted);
    disposers.push(() => {
      owner.abort.abort();
      owner.disposers.forEach((dispose) => dispose());
      runtime.dispose();
    });
    return createControlUiPluginHost(getContext, runtime, owner);
  }

  function hello() {
    store.current().opts.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  }

  const rosterPayload = { sessionKey: "agent:main:background", messageId: "message-1" };
  const fullPayload = { ...rosterPayload, message: { role: "assistant", content: "Complete" } };
  function emit(payload: unknown) {
    store.current().opts.onEvent?.(createGatewayEvent("session.message", payload));
  }

  it("shares runtime body interest, filters the admission window, and reverts after the last listener", async () => {
    store.gateway.start();
    hello();
    const admission = createDeferred<unknown>();
    store
      .current()
      .request.mockImplementation((method) =>
        method === "sessions.subscribe" ? admission.promise : Promise.resolve(null),
      );
    const core = vi.fn();
    disposers.push(store.gateway.subscribeEvents(core));
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = host("first").onEvent("session.message", first);
    const stopSecond = host("second").onEvent("session.message", second);
    const bodyRequests = () =>
      store.current().request.mock.calls.filter(([method]) => method === "sessions.subscribe");
    expect(bodyRequests()).toEqual([["sessions.subscribe", { includeMessageBodies: true }]]);

    emit(rosterPayload);
    expect(core).toHaveBeenCalledWith(expect.objectContaining({ payload: rosterPayload }));
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    admission.resolve({ subscribed: true });
    await admission.promise;
    emit(fullPayload);
    expect(first).toHaveBeenCalledExactlyOnceWith(fullPayload);
    expect(second).toHaveBeenCalledExactlyOnceWith(fullPayload);

    stopFirst();
    stopFirst();
    expect(bodyRequests()).toHaveLength(1);
    emit(fullPayload);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
    expect(bodyRequests()).toEqual([
      ["sessions.subscribe", { includeMessageBodies: true }],
      ["sessions.subscribe", { includeMessageBodies: false }],
    ]);
    emit(rosterPayload);
    expect(core).toHaveBeenCalledTimes(4);
    expect(store.clients).toHaveLength(1);
    expect(store.current().stopped).toBe(0);
  });

  it("includes existing interest in initial and reconnect handshakes without extra admission requests", () => {
    const listener = vi.fn();
    const stop = host("early").onEvent("session.message", listener);
    store.gateway.start();
    expect(store.current().opts.includeSessionMessageBodies).toBe(true);
    store.current().request.mockResolvedValue({ subscribed: true });
    hello();
    emit(fullPayload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(fullPayload);
    expect(store.current().request).not.toHaveBeenCalledWith(
      "sessions.subscribe",
      expect.anything(),
    );

    store.current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    expect(store.current().opts.includeSessionMessageBodies).toBe(true);
    hello();
    emit(fullPayload);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.current().request).not.toHaveBeenCalledWith(
      "sessions.subscribe",
      expect.anything(),
    );
    stop();
    expect(store.current().request).toHaveBeenCalledWith("sessions.subscribe", {
      includeMessageBodies: false,
    });
  });

  it("admits interest registered after connect parameters were sent and retires it with the activation", async () => {
    store.gateway.start();
    expect(store.current().opts.includeSessionMessageBodies).toBeUndefined();
    store.current().request.mockResolvedValue({ subscribed: true });
    const listener = vi.fn();
    host("connecting").onEvent("session.message", listener);
    hello();
    expect(store.current().request).toHaveBeenCalledWith("sessions.subscribe", {
      includeMessageBodies: true,
    });
    emit(rosterPayload);
    expect(listener).not.toHaveBeenCalled();
    await Promise.resolve();
    emit(fullPayload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(fullPayload);
    disposers.pop()?.();
    expect(store.current().request).toHaveBeenCalledWith("sessions.subscribe", {
      includeMessageBodies: false,
    });
    emit(fullPayload);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("reverts interest removed after the handshake parameters were sent", () => {
    const stop = host("retiring").onEvent("session.message", vi.fn());
    store.gateway.start();
    expect(store.current().opts.includeSessionMessageBodies).toBe(true);
    stop();
    store.current().request.mockResolvedValue({ subscribed: true });
    hello();
    expect(store.current().request).toHaveBeenCalledWith("sessions.subscribe", {
      includeMessageBodies: false,
    });
  });

  it("reports rejected admission and retries only when another listener registers", async () => {
    store.gateway.start();
    hello();
    const admission = createDeferred<unknown>();
    store.current().request.mockReturnValueOnce(admission.promise);
    const first = vi.fn();
    host("rejected").onEvent("session.message", first);
    admission.reject(new Error("Admission unavailable"));
    await admission.promise.catch(() => {});
    await Promise.resolve();
    expect(store.gateway.snapshot.lastError).toBe("Admission unavailable");
    emit(rosterPayload);
    expect(first).not.toHaveBeenCalled();
    const beforeRetry = store
      .current()
      .request.mock.calls.filter(([method]) => method === "sessions.subscribe");
    expect(beforeRetry).toHaveLength(1);
    store.current().request.mockResolvedValue({ subscribed: true });
    const second = vi.fn();
    host("retrying").onEvent("session.message", second);
    expect(
      store.current().request.mock.calls.filter(([method]) => method === "sessions.subscribe"),
    ).toHaveLength(2);
    await Promise.resolve();
    emit(fullPayload);
    expect(first).toHaveBeenCalledExactlyOnceWith(fullPayload);
    expect(second).toHaveBeenCalledExactlyOnceWith(fullPayload);
  });
});
