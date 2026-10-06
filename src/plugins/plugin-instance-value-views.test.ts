import { describe, expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRecord } from "./registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function createOwnedInstance(origin: PluginRecord["origin"] = "bundled") {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "direct-values", origin });
  registry.plugins.push(record);
  return new PluginInstance(record.id, { record, registry });
}

describe("admitted plugin values", () => {
  it.each(
    (["bundled", "global", "workspace"] as const).flatMap((origin) =>
      (["hook", "async tool"] as const).map((kind) => ({ origin, kind })),
    ),
  )(
    "passes $origin $kind data by reference without inspecting nested values",
    async ({ origin, kind }) => {
      const instance = createOwnedInstance(origin);
      const opaque = new Proxy(
        {},
        {
          get() {
            throw new Error("Nested payload must not be inspected");
          },
          ownKeys() {
            throw new Error("Nested payload must not be traversed");
          },
          getPrototypeOf() {
            throw new Error("Nested payload must not be classified");
          },
        },
      );
      const handle = instance.wrap({ read: () => "handle" });
      const input = Object.freeze({ handle, opaque });
      const payload = Object.freeze({
        content: Object.freeze([{ text: "chunk" }]),
        read: () => "payload",
        opaque,
      });
      const operation = instance.wrap((argument: typeof input) => {
        expect(instance.hasActiveCall).toBe(true);
        expect(argument).toBe(input);
        expect(argument.handle).toBe(handle);
        return kind === "async tool" ? Promise.resolve(payload) : payload;
      });
      try {
        const result = await operation(input);
        expect(result).toBe(payload);
        expect(result.opaque).toBe(opaque);
        await instance.dispose();
        expect(result.read()).toBe("payload");
        expect(result.content[0]?.text).toBe("chunk");
      } finally {
        await instance.dispose();
      }
    },
  );

  it("passes callback payloads by reference while the callback keeps invocation admission", async () => {
    const instance = createOwnedInstance();
    const payload = Object.freeze({ read: () => "callback payload" });
    const invoke = instance.wrap((callback: (value: typeof payload) => void) => callback(payload));
    let received: typeof payload | undefined;
    try {
      invoke((value) => {
        expect(instance.hasActiveCall).toBe(true);
        expect(getPluginRuntimeGatewayRequestScope()?.pluginId).toBe(instance.pluginId);
        received = value;
      });
      expect(received).toBe(payload);
      await instance.dispose();
      expect(received?.read()).toBe("callback payload");
    } finally {
      await instance.dispose();
    }
  });

  it("keeps exact nested stream results and one scoped private-field receiver across protocol calls", async () => {
    const instance = createOwnedInstance();
    const inner = instance.retainConsumer();
    const outer = instance.retainConsumer();
    const scopes: Array<ReturnType<typeof getPluginRuntimeGatewayRequestScope>> = [];
    const results = [
      Object.freeze({ done: false, value: Object.freeze({ read: () => "first" }) }),
      Object.freeze({ done: false, value: Object.freeze({ read: () => "recovered" }) }),
      Object.freeze({ done: true, value: Object.freeze({ read: () => "closed" }) }),
    ];
    const failure = new Error("recoverable stream error");
    const observeScope = () => {
      const scope = getPluginRuntimeGatewayRequestScope();
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

      async throw(error: unknown) {
        expect(error).toBe(failure);
        observeScope();
        await Promise.resolve();
        observeScope();
        return results[this.#index++]!;
      }

      async return() {
        observeScope();
        await Promise.resolve();
        observeScope();
        return results[this.#index++]!;
      }
    }
    const source = instance.wrap(() => new Stream())();
    const iterator = outer.wrap(inner.wrap(source))[Symbol.asyncIterator]();
    try {
      expect(await iterator.next()).toBe(results[0]);
      expect(await iterator.throw(failure)).toBe(results[1]);
      expect(await iterator.return()).toBe(results[2]);
      expect(scopes).toHaveLength(6);
      for (const scope of scopes) {
        expect(scope).toBe(scopes[0]);
      }
      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
      inner.release();
      outer.release();
      await instance.dispose();
      expect(results.map((result) => result.value.read())).toEqual([
        "first",
        "recovered",
        "closed",
      ]);
    } finally {
      await iterator.return();
      inner.release();
      outer.release();
      await instance.dispose();
    }
  });
});
