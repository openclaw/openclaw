import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOwnedTestInstance,
  expectLiveObjects,
  readRegistryLabel,
  selectRegistry,
  throwing,
} from "./plugin-instance.test-support.js";
import { getPluginRuntimeGatewayRequestScope as getScope } from "./runtime/gateway-request-scope.js";

it.each(["ordinary", "consumer"] as const)(
  "retains an adopted registry through idle and pending %s iteration, then releases it",
  async (custody) => {
    class StreamRegistry {
      readonly fixtureLabel = "StreamRegistry";
    }
    const instance = createOwnedTestInstance("direct-values", "bundled");
    const record = instance.owner!.record;
    const consumer = custody === "consumer" ? instance.retainConsumer() : undefined;
    const resume = createDeferredCore();
    const observed: Array<string | undefined> = [];
    const observe = () => observed.push(readRegistryLabel());
    async function* stream() {
      try {
        observe();
        yield "first";
        observe();
        await resume.promise;
        observe();
        yield "second";
      } finally {
        observe();
      }
    }
    selectRegistry(record, "selected", new StreamRegistry());
    const iterator = (consumer ?? instance).wrap(stream())[Symbol.asyncIterator]();
    selectRegistry(record, "successor");
    let pending: ReturnType<typeof iterator.next> | undefined;
    try {
      await expectLiveObjects(StreamRegistry, 1);
      expect(await iterator.next()).toEqual({ done: false, value: "first" });
      pending = iterator.next();
      await expectLiveObjects(StreamRegistry, 1);
      resume.resolve();
      expect(await pending).toEqual({ done: false, value: "second" });
      await expectLiveObjects(StreamRegistry, 1);
      expect(await iterator.return()).toEqual({ done: true, value: undefined });
      await expectLiveObjects(StreamRegistry, 0);
      expect(observed).toEqual(["selected", "selected", "selected", "selected"]);
      expect((consumer ?? instance).run(readRegistryLabel)).toBe("successor");
    } finally {
      resume.resolve();
      await pending?.catch(() => {});
      await iterator.return().catch(() => {});
      consumer?.release();
      await instance.dispose();
    }
  },
);

it.each(["hook", "async tool"] as const)(
  "passes %s data by reference without inspecting nested values",
  async (kind) => {
    const instance = createOwnedTestInstance("direct-values", "bundled");
    const deny = throwing(new Error("Nested payload must not be inspected"));
    const opaque = new Proxy({}, { get: deny, ownKeys: deny, getPrototypeOf: deny });
    const handle = instance.wrap({ read: () => "handle" });
    const input = Object.freeze({ handle, opaque });
    const payload = Object.freeze({
      read: () => "payload",
      opaque,
    });
    const operation = instance.wrap(
      (argument: typeof input, callback: (value: typeof payload) => void) => {
        expect(instance.hasActiveCall).toBe(true);
        expect(argument).toBe(input);
        callback(payload);
        return kind === "async tool" ? Promise.resolve(payload) : payload;
      },
    );
    let received: typeof payload | undefined;
    const result = await operation(input, (value) => {
      expect(instance.hasActiveCall).toBe(true);
      expect(getScope()?.pluginId).toBe(instance.pluginId);
      received = value;
    });
    expect(result).toBe(payload);
    expect(received).toBe(payload);
    await instance.dispose();
    expect(result.read()).toBe("payload");
  },
);

it("keeps exact nested stream results and one scoped private-field receiver across protocol calls", async () => {
  const instance = createOwnedTestInstance("direct-values", "bundled");
  const inner = instance.retainConsumer();
  const outer = instance.retainConsumer();
  const scopes: Array<ReturnType<typeof getScope>> = [];
  const results = [
    Object.freeze({ done: false, value: Object.freeze({ read: () => "first" }) }),
    Object.freeze({ done: false, value: Object.freeze({ read: () => "recovered" }) }),
    Object.freeze({ done: true, value: Object.freeze({ read: () => "closed" }) }),
  ];
  const failure = new Error("recoverable stream error");
  const observeScope = () => {
    const scope = getScope();
    expect(instance.hasActiveCall).toBe(true);
    expect(scope?.pluginId).toBe(instance.pluginId);
    scopes.push(scope);
  };
  class Stream {
    #index = 0;

    [Symbol.asyncIterator]() {
      expect(instance.hasActiveCall).toBe(true);
      return this;
    }

    async next() {
      observeScope();
      await Promise.resolve();
      observeScope();
      return results[this.#index++]!;
    }

    throw(error: unknown) {
      expect(error).toBe(failure);
      return this.next();
    }

    return() {
      return this.next();
    }
  }
  const source = instance.wrap(() => new Stream())();
  const iterator = outer.wrap(inner.wrap(source))[Symbol.asyncIterator]();
  try {
    expect(await iterator.next()).toBe(results[0]);
    expect(await iterator.throw(failure)).toBe(results[1]);
    expect(await iterator.return()).toBe(results[2]);
    expect(scopes.every((scope) => scope === scopes[0])).toBe(true);
    expect(getScope()).toBeUndefined();
    inner.release();
    outer.release();
    await instance.dispose();
    expect(results.map((result) => result.value.read())).toEqual(["first", "recovered", "closed"]);
  } finally {
    await iterator.return();
    inner.release();
    outer.release();
    await instance.dispose();
  }
});
