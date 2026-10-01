/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayPresenceActivity } from "./gateway-presence-activity.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  vi.restoreAllMocks();
});

function setup(visibility: DocumentVisibilityState = "visible") {
  const target = document.implementation.createHTMLDocument();
  const visible = vi.spyOn(target, "visibilityState", "get").mockReturnValue(visibility);
  const added = vi.spyOn(target, "addEventListener");
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  disposers.push(() => store.gateway.stop());
  store.current().request.mockResolvedValue({ ok: true });
  const stop = startGatewayPresenceActivity(store.gateway, target);
  disposers.push(stop);
  const ready = () => store.current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  const input = (type: string, trusted = true) => {
    const callback = added.mock.calls.find(([event]) => event === type)?.[1];
    if (typeof callback === "function") {
      // jsdom cannot create trusted browser input; exercise the installed listener.
      callback.call(target, { isTrusted: trusted } as Event);
    }
  };
  return { ...store, target, visible, ready, input, stop };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Control UI presence activity", () => {
  it("reports the first foreground ready visit once per document, not reconnect or remount", async () => {
    const store = setup();
    const first = store.current();
    expect(first.request).not.toHaveBeenCalled();
    store.ready();
    await settle();
    expect(first.request).toHaveBeenCalledExactlyOnceWith("presence.activity", {});
    store.gateway.connect();
    store.current().request.mockResolvedValue({ ok: true });
    store.ready();
    expect(store.current().request).not.toHaveBeenCalled();
    store.stop();
    disposers.push(startGatewayPresenceActivity(store.gateway, store.target));
    expect(store.current().request).not.toHaveBeenCalled();
  });

  it("does not convert hidden initial ready, visibility recovery, events or synthetic scrolling into activity", async () => {
    const store = setup("hidden");
    store.ready();
    store.input("keydown");
    store.visible.mockReturnValue("visible");
    store.target.dispatchEvent(new Event("visibilitychange"));
    store.target.dispatchEvent(new Event("scroll"));
    store.input("pointerdown", false);
    store
      .current()
      .opts.onEvent?.({ type: "event", event: "chat", payload: { text: "agent output" } });
    store.current().opts.onEvent?.({ type: "event", event: "tick" });
    expect(store.current().request).not.toHaveBeenCalled();
    store.input("wheel");
    await settle();
    expect(store.current().request).toHaveBeenCalledExactlyOnceWith("presence.activity", {});
  });

  it("throttles continuous trusted input and reports immediately after idle without trailing work", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = setup("hidden");
    store.ready();
    store.visible.mockReturnValue("visible");
    for (const [index, type] of [
      "keydown",
      "pointerdown",
      "pointermove",
      "wheel",
      "touchstart",
    ].entries()) {
      clock.mockReturnValue(1_000 + index * 30_000);
      store.input(type);
      await settle();
      store.input(type);
      expect(store.current().request).toHaveBeenCalledTimes(index + 1);
    }
    clock.mockReturnValue(500_000);
    await settle();
    expect(store.current().request).toHaveBeenCalledTimes(5);
    store.input("pointerdown");
    await settle();
    expect(store.current().request).toHaveBeenCalledTimes(6);
    clock.mockReturnValue(499_000);
    store.input("keydown");
    await settle();
    expect(store.current().request).toHaveBeenCalledTimes(7);
  });

  it("drops disconnected and hidden input and retires listeners on disposal", async () => {
    const store = setup("hidden");
    store.input("keydown");
    store.ready();
    store.visible.mockReturnValue("visible");
    store.current().opts.onClose?.({ code: 1006, reason: "closed", willRetry: true });
    store.input("pointerdown");
    store.ready();
    expect(store.current().request).not.toHaveBeenCalled();
    store.stop();
    store.input("keydown");
    store.ready();
    expect(store.current().request).not.toHaveBeenCalled();
    const removed = vi.spyOn(store.target, "removeEventListener");
    const stop = startGatewayPresenceActivity(store.gateway, store.target);
    stop();
    expect(removed.mock.calls.map(([type]) => type)).toEqual([
      "keydown",
      "pointerdown",
      "pointermove",
      "wheel",
      "touchstart",
    ]);
  });

  it("keeps one request in flight and never retries a failed interaction without new input", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = setup();
    let reject!: (error: Error) => void;
    store.current().request.mockImplementation(
      () =>
        new Promise((_resolve, rejectRequest) => {
          reject = rejectRequest;
        }),
    );
    store.ready();
    clock.mockReturnValue(61_000);
    store.input("keydown");
    expect(store.current().request).toHaveBeenCalledOnce();
    reject(new Error("offline"));
    await settle();
    expect(store.current().request).toHaveBeenCalledOnce();
    store.current().request.mockResolvedValue({ ok: true });
    store.input("keydown");
    await settle();
    expect(store.current().request).toHaveBeenCalledTimes(2);
  });
});
