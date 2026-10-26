import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createFeatureClient,
  defineFeatureContract,
  type FeatureClient,
  type FeatureClientContract,
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
    update: {
      kind: "action",
      description: "Update",
      input: Type.Object({ value: Type.String() }),
      output: Type.Boolean(),
    },
  },
  events: { changed: Type.Object({}) },
});

const browserContract = {
  pluginId: "feature-fixture",
  operations: { inspect: { kind: "query" }, update: { kind: "action" } },
} satisfies FeatureClientContract<typeof contract>;

function watchFixture(clientContract: FeatureClientContract<typeof contract>, sessionKey?: string) {
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
  const client = createFeatureClient<typeof contract>(clientContract, host);
  const dispose = client.watch("inspect", {}, options);
  return {
    client,
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

describe.each([
  { name: "schema contract", clientContract: contract },
  { name: "browser contract", clientContract: browserContract },
])("$name", ({ clientContract }) => {
  it("refreshes watched queries on events and reconnect while fencing stale results", async () => {
    const fixture = watchFixture(clientContract, "agent:fixture:task");
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
    const fixture = watchFixture(clientContract);
    await Promise.resolve();
    fixture.controller.abort();
    await fixture.settle({ ok: true, result: "late" });
    expect(fixture.onChange).not.toHaveBeenCalled();
    expect(fixture.onError).not.toHaveBeenCalled();
    expect(fixture.subscriptions()).toEqual([0, 0]);
  });
});

it("preserves canonical client inference and query-only watches without schemas", () => {
  const fixture = watchFixture(browserContract);
  const inferred = createFeatureClient(contract, fixture.host);
  expectTypeOf(inferred).toEqualTypeOf<FeatureClient<typeof contract>>();
  expectTypeOf(fixture.client).toEqualTypeOf<typeof inferred>();
  expectTypeOf<Parameters<typeof fixture.client.watch>[0]>().toEqualTypeOf<"inspect">();
  expectTypeOf<ReturnType<typeof fixture.client.invoke<"update">>>().toEqualTypeOf<
    Promise<boolean>
  >();
  expect(() =>
    Reflect.apply(fixture.client.watch, undefined, [
      "update",
      { value: "changed" },
      { events: ["changed"], onChange: vi.fn(), onError: vi.fn() },
    ]),
  ).toThrow("Only feature queries can be watched");
  fixture.controller.abort();
});
