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
    store.current().testOptions.onHello?.({ ...GATEWAY_STORE_TEST_HELLO });
  }
  function start() {
    store.gateway.start();
    hello();
  }
  const listen = (plugin: string, listener: (payload: unknown) => void) =>
    host(plugin).onEvent("session.message", listener);
  const bodyRequests = () =>
    store.current().request.mock.calls.filter(([method]) => method === "sessions.subscribe");
  const expectInterest = (includeMessageBodies: boolean) =>
    expect(store.current().request).toHaveBeenCalledWith("sessions.subscribe", {
      includeMessageBodies,
    });

  const rosterPayload = { sessionKey: "agent:main:background", messageId: "message-1" };
  const fullPayload = { ...rosterPayload, message: { role: "assistant", content: "Complete" } };
  function emit(payload: unknown) {
    store.current().testOptions.onEvent?.(createGatewayEvent("session.message", payload));
  }

  it("shares runtime body interest, filters the admission window, and reverts after the last listener", async () => {
    start();
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
    const stopFirst = listen("first", first);
    const stopSecond = listen("second", second);
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

  it.each(["early", "connecting", "retiring"])(
    "negotiates %s listener interest",
    async (timing) => {
      const listener = vi.fn();
      const stop = timing === "connecting" ? undefined : listen(timing, listener);
      store.gateway.start();
      expect(store.current().testOptions.includeSessionMessageBodies).toBe(
        timing === "connecting" ? undefined : true,
      );
      store.current().request.mockResolvedValue({ subscribed: true });
      if (timing === "connecting") {
        listen(timing, listener);
      }
      if (timing === "retiring") {
        stop?.();
      }
      hello();
      if (timing === "retiring") {
        expectInterest(false);
        return;
      }
      if (timing === "connecting") {
        expectInterest(true);
        emit(rosterPayload);
        expect(listener).not.toHaveBeenCalled();
        await Promise.resolve();
      }
      emit(fullPayload);
      expect(listener).toHaveBeenCalledExactlyOnceWith(fullPayload);
      if (timing === "early") {
        expect(bodyRequests()).toEqual([]);
        store
          .current()
          .testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
        expect(store.current().testOptions.includeSessionMessageBodies).toBe(true);
        hello();
        emit(fullPayload);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(bodyRequests()).toEqual([]);
        stop?.();
      } else {
        disposers.pop()?.();
      }
      expectInterest(false);
      if (timing === "connecting") {
        emit(fullPayload);
        expect(listener).toHaveBeenCalledOnce();
      }
    },
  );

  it("reports rejected admission and retries only when another listener registers", async () => {
    start();
    const admission = createDeferred<unknown>();
    store.current().request.mockReturnValueOnce(admission.promise);
    const first = vi.fn();
    listen("rejected", first);
    admission.reject(new Error("Admission unavailable"));
    await admission.promise.catch(() => {});
    await Promise.resolve();
    expect(store.gateway.snapshot.lastError).toBe("Admission unavailable");
    emit(rosterPayload);
    expect(first).not.toHaveBeenCalled();
    expect(bodyRequests()).toHaveLength(1);
    store.current().request.mockResolvedValue({ subscribed: true });
    const second = vi.fn();
    listen("retrying", second);
    expect(bodyRequests()).toHaveLength(2);
    await Promise.resolve();
    emit(fullPayload);
    expect(first).toHaveBeenCalledExactlyOnceWith(fullPayload);
    expect(second).toHaveBeenCalledExactlyOnceWith(fullPayload);
  });
});
