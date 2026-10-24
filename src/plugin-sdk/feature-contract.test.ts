import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import {
  createFeatureClient,
  defineFeatureContract,
  type FeatureTransport,
} from "./feature-contract.js";

const contract = defineFeatureContract({
  pluginId: "feature-fixture",
  operations: {
    inspect: {
      kind: "query",
      description: "Inspect",
      input: Type.Object({}),
      output: Type.String(),
    },
  },
  events: { changed: Type.Object({}) },
});

function watchFixture(sessionKey?: string) {
  const controller = new AbortController();
  const events = new Map<string, (payload: unknown) => void>();
  const listeners = new Set<() => void>();
  const pending: Array<(value: unknown) => void> = [];
  const host: FeatureTransport = {
    pluginId: contract.pluginId,
    signal: controller.signal,
    connection: { connected: true },
    request<T>(): Promise<T> {
      return new Promise<T>((resolve) => {
        pending.push((value) => resolve(value as T));
      });
    },
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      events.set(event, listener);
      return () => events.delete(event);
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  vi.spyOn(host, "request");
  const callbacks = { onChange: vi.fn(), onError: vi.fn() };
  const options = { events: ["changed"] as const, ...callbacks, sessionKey };
  const dispose = createFeatureClient(contract, host).watch("inspect", {}, options);
  return {
    host,
    controller,
    ...callbacks,
    dispose,
    changed: () => events.get("plugin.feature-fixture.changed")?.({}),
    subscriptions: () => [events.size, listeners.size],
    connect(connected: boolean) {
      host.connection.connected = connected;
      for (const listener of listeners) {
        listener();
      }
    },
    async settle(...responses: unknown[]) {
      for (const response of responses) {
        pending.shift()?.(response);
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

it("refreshes watched queries on events and reconnect while fencing stale results", async () => {
  const fixture = watchFixture("agent:fixture:task");
  await Promise.resolve();
  expect(fixture.host.request).toHaveBeenCalledWith("plugins.sessionAction", {
    pluginId: contract.pluginId,
    actionId: "inspect",
    payload: {},
    sessionKey: "agent:fixture:task",
    agentId: undefined,
  });
  fixture.changed();
  await Promise.resolve();
  await fixture.settle({ ok: true, result: "stale" }, { ok: true, result: "current" });
  expect(fixture.onChange.mock.calls).toEqual([["current"]]);

  fixture.connect(false);
  fixture.changed();
  await Promise.resolve();
  expect(fixture.host.request).toHaveBeenCalledTimes(2);
  fixture.connect(true);
  await Promise.resolve();
  expect(fixture.host.request).toHaveBeenCalledTimes(3);
  await fixture.settle({ ok: false, error: "query unavailable" });
  expect(fixture.onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "query unavailable" }),
  );
  fixture.dispose();
  expect(fixture.subscriptions()).toEqual([0, 0]);
});

it("disposes event subscriptions and in-flight deliveries with the browser owner", async () => {
  const fixture = watchFixture();
  await Promise.resolve();
  fixture.controller.abort();
  await fixture.settle({ ok: true, result: "late" });
  expect(fixture.onChange).not.toHaveBeenCalled();
  expect(fixture.onError).not.toHaveBeenCalled();
  expect(fixture.subscriptions()).toEqual([0, 0]);
});
