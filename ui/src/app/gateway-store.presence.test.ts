// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nativePresenceStream from "../../../apps/shared/OpenClawKit/Tests/OpenClawKitTests/Fixtures/presence-deltas.json" with { type: "json" };
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";

const first = { ts: 1, instanceId: "first", host: "First" };
const second = { ts: 2, instanceId: "second", host: "Second" };
const hello = () => ({ ...GATEWAY_STORE_TEST_HELLO, snapshot: { presence: [first] } });
const reset = (version: number, presence = [first], keys = ["first-key"]) => ({
  reset: true,
  version,
  presence,
  keys,
});
const delta = (base: number, fields: object = {}) => ({
  base,
  version: base + 1,
  upsert: [],
  remove: [],
  order: [],
  ...fields,
});
const send = (payload: unknown) =>
  store.current().testOptions.onEvent?.(createGatewayEvent("presence", payload));

let store: ReturnType<typeof createGatewayStoreTestStore>;
beforeEach(() => {
  stubGatewayStoreTestGlobals();
  store = createGatewayStoreTestStore();
  store.gateway.start();
  store.current().testOptions.onHello?.(hello());
});
afterEach(() => {
  store.gateway.stop();
  vi.unstubAllGlobals();
});

describe("Gateway presence delivery", () => {
  it("matches the shared native presence stream", () => {
    store.current().request.mockImplementation(() => new Promise(() => {}));
    const events = vi.fn();
    store.gateway.subscribeEvents(events);
    for (const step of nativePresenceStream) {
      if (step.reconnect) {
        store.current().testOptions.onHello?.(hello());
      }
      events.mockClear();
      store.current().testOptions.onEvent?.(createGatewayEvent("presence", step.payload));
      if (step.expected === null) {
        expect(events, step.name).not.toHaveBeenCalled();
      } else {
        expect(events.mock.lastCall?.[0].payload, step.name).toEqual({ presence: step.expected });
      }
    }
  });

  it("publishes reconstructed snapshots to every consumer in server order", () => {
    const events = vi.fn();
    store.gateway.subscribeEvents(events);
    store.gateway.subscribeEventLog(() => {});
    send(reset(2));
    const changed = { ...first, host: "Changed" };
    send(
      delta(2, {
        upsert: [
          { key: "first-key", presence: changed },
          { key: "second-key", presence: second },
        ],
        order: ["second-key", "first-key"],
      }),
    );
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [second, changed] });
    expect(store.gateway.eventLog[0]?.payload).toEqual({ presence: [second, changed] });
    send(delta(3, { remove: ["first-key"], order: ["second-key"] }));
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [second] });
    send(reset(5));
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [first] });
    expect(store.current().request).not.toHaveBeenCalled();
  });

  it("applies field patches without losing metadata or retaining cleared fields", () => {
    const events = vi.fn();
    store.gateway.subscribeEvents(events);
    const original = { ...first, watchedSessions: ["agent:main:old"], roles: ["operator"] };
    send(reset(2, [original]));
    send(
      delta(2, {
        upsert: [
          { key: "first-key", set: { ts: 20, roles: ["node"] }, unset: ["watchedSessions"] },
          { key: "second-key", presence: second },
        ],
        order: ["second-key", "first-key"],
      }),
    );
    expect(events.mock.lastCall?.[0].payload).toEqual({
      presence: [second, { ...first, ts: 20, roles: ["node"] }],
    });
    expect(original.watchedSessions).toEqual(["agent:main:old"]);
    expect(original.ts).toBe(1);
    expect(store.current().request).not.toHaveBeenCalled();

    send(
      delta(3, {
        upsert: [{ key: "missing-key", set: { ts: 30 }, unset: [] }],
        order: ["second-key", "first-key", "missing-key"],
      }),
    );
    expect(events).toHaveBeenCalledTimes(2);
    expect(store.current().request).toHaveBeenCalledWith("system-presence", { snapshot: true });
  });

  it("deduplicates mismatched deltas and publishes the recovered full snapshot", async () => {
    const recovery = createDeferred<ReturnType<typeof reset>>();
    store.current().request.mockReturnValue(recovery.promise);
    const events = vi.fn();
    store.gateway.subscribeEvents(events);
    send(delta(1));
    send(delta(1));
    expect(store.current().request).toHaveBeenCalledTimes(1);
    expect(store.current().request).toHaveBeenCalledWith("system-presence", { snapshot: true });
    expect(events).not.toHaveBeenCalled();
    recovery.resolve(reset(4, [second], ["second-key"]));
    await recovery.promise;
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [second] });
    send(delta(4, { remove: ["second-key"] }));
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [] });
  });

  it("never replaces a newer full event with a pending recovery, even at equal version", async () => {
    const recovery = createDeferred<ReturnType<typeof reset>>();
    store.current().request.mockReturnValue(recovery.promise);
    const events = vi.fn();
    store.gateway.subscribeEvents(events);
    send(delta(9));
    send(reset(10));
    recovery.resolve(reset(10, [second], ["second-key"]));
    await recovery.promise;
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [first] });
  });

  it("retires keyed state and pending recovery on a new hello from the same client", async () => {
    const recovery = createDeferred<ReturnType<typeof reset>>();
    const current = store.current();
    current.request.mockReturnValue(recovery.promise);
    const events = vi.fn();
    store.gateway.subscribeEvents(events);
    send(reset(2));
    send(delta(9));
    current.testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    current.testOptions.onHello?.(hello());
    recovery.resolve(reset(10, [second], ["second-key"]));
    await recovery.promise;
    expect(events).toHaveBeenCalledTimes(1);
    send(reset(1));
    send(
      delta(1, {
        upsert: [{ key: "second-key", presence: second }],
        remove: ["first-key"],
        order: ["second-key"],
      }),
    );
    expect(events.mock.lastCall?.[0].payload).toEqual({ presence: [second] });
  });
});
