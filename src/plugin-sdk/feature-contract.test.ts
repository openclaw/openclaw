import { Type } from "typebox";
import { expect, expectTypeOf, it, vi } from "vitest";
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
  const client = createFeatureClient<typeof contract>(clientContract, host);
  const dispose = client.watch("inspect", {}, { events: ["changed"], ...callbacks, sessionKey });
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

it.each(["dispose", "abort"] as const)(
  "refreshes queries, fences stale results, and closes via %s",
  async (close) => {
    const f = watchFixture(browserContract, "agent:fixture:task");
    await Promise.resolve();
    expect(f.host.request).toHaveBeenCalledWith("plugins.sessionAction", {
      pluginId: contract.pluginId,
      actionId: "inspect",
      payload: {},
      sessionKey: "agent:fixture:task",
      agentId: undefined,
    });
    f.changed();
    await Promise.resolve();
    await f.settle({ ok: true, result: "stale" }, { ok: true, result: "current" });
    expect(f.onChange.mock.calls).toEqual([["current"]]);
    f.connect(false);
    f.changed();
    await Promise.resolve();
    expect(f.host.request).toHaveBeenCalledTimes(2);
    f.connect(true);
    await Promise.resolve();
    await f.settle({ ok: false, error: "query unavailable" });
    expect(f.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "query unavailable" }),
    );
    f.onChange.mockClear();
    f.onError.mockClear();
    f.changed();
    await Promise.resolve();
    if (close === "abort") {
      f.controller.abort();
    } else {
      f.dispose();
    }
    await f.settle({ ok: true, result: "late" });
    expect(f.onChange).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.subscriptions()).toEqual([0, 0]);
  },
);

it("preserves canonical client inference and query-only watches without schemas", () => {
  const { client, host, controller } = watchFixture(browserContract);
  const inferred = createFeatureClient(contract, host);
  expectTypeOf(inferred).toEqualTypeOf<FeatureClient<typeof contract>>();
  expectTypeOf(client).toEqualTypeOf<typeof inferred>();
  expectTypeOf<Parameters<typeof client.watch>[0]>().toEqualTypeOf<"inspect">();
  expectTypeOf<ReturnType<typeof client.invoke<"update">>>().toEqualTypeOf<Promise<boolean>>();
  expect(() =>
    Reflect.apply(client.watch, undefined, ["update", { value: "changed" }, {}]),
  ).toThrow("Only feature queries can be watched");
  controller.abort();
});
