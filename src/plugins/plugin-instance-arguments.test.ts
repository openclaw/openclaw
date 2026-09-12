import { describe, expect, it, vi } from "vitest";
import { PluginInstance } from "./plugin-instance.js";

describe("plugin argument restoration", () => {
  it.each([false, true])(
    "does not snapshot untouched payload descriptors (with local handle: %s)",
    async (withHandle) => {
      const instance = new PluginInstance("argument-allocation");
      const original = { read: () => 42 };
      const view = instance.wrap(original);
      const messages = Array.from({ length: 1_000 }, (_, id) => ({
        id,
        content: [{ type: "text", text: `message ${id}` }],
      }));
      const input = { messages, ...(withHandle ? { handle: view } : {}) };
      let received: typeof input | undefined;
      const consume = instance.wrap((value: typeof input) => {
        received = value;
      });
      // Bulk descriptor snapshots retain metadata for every message property until
      // the walk finishes. Only an ancestor requiring a copy needs that allocation.
      const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptors");
      try {
        consume(input);
        const descriptorTargets = descriptors.mock.calls.map(([value]) => value);
        expect(descriptorTargets).toHaveLength(withHandle ? 1 : 0);
        if (withHandle) {
          expect(descriptorTargets[0]).toBe(input);
        }
        expect(received?.messages).toBe(messages);
        expect(received?.handle).toBe(withHandle ? original : undefined);
        if (withHandle) {
          expect(received).not.toBe(input);
          expect(input.handle).toBe(view);
        } else {
          expect(received).toBe(input);
        }
      } finally {
        descriptors.mockRestore();
        await instance.dispose();
      }
    },
  );

  it("preserves cycles and aliases through every copied parent", async () => {
    const instance = new PluginInstance("argument-graph");
    const original = { read: () => 42 };
    const view = instance.wrap(original);
    const stable = { label: "unchanged" };
    const shared: { handle: typeof view; parent?: unknown } = { handle: view };
    const left = { shared };
    const right = { shared };
    const input = { left, right, stable };
    shared.parent = input;
    const consume = instance.wrap((received: typeof input, alias: typeof shared) => {
      expect(received).not.toBe(input);
      expect(received.left).not.toBe(left);
      expect(received.right).not.toBe(right);
      expect(received.left.shared).toBe(received.right.shared);
      expect(received.left.shared).toBe(alias);
      expect(alias.parent).toBe(received);
      expect(alias.handle).toBe(original);
      expect(received.stable).toBe(stable);
    });
    try {
      consume(input, shared);
      expect(shared.handle).toBe(view);
      expect(shared.parent).toBe(input);
    } finally {
      await instance.dispose();
    }
  });

  it("preserves frozen sparse arrays and symbol/non-enumerable descriptors", async () => {
    const instance = new PluginInstance("argument-descriptors");
    const original = { read: () => 42 };
    const view = instance.wrap(original);
    const symbol = Symbol("handle");
    const array: unknown[] = [];
    array.length = 8;
    Object.defineProperty(array, "3", { value: view, enumerable: true });
    Object.defineProperty(array, symbol, { value: view });
    Object.freeze(array);
    const input = Object.create(null) as { array: typeof array; hidden: typeof view };
    Object.defineProperty(input, "array", { value: array, enumerable: true });
    Object.defineProperty(input, "hidden", { value: view });
    const consume = instance.wrap((received: typeof input) => {
      expect(Object.getPrototypeOf(received)).toBeNull();
      expect(received.array.length).toBe(8);
      expect(0 in received.array).toBe(false);
      expect(received.array[3]).toBe(original);
      expect(Reflect.get(received.array, symbol)).toBe(original);
      for (const key of ["3", symbol]) {
        expect(Object.getOwnPropertyDescriptor(received.array, key)).toEqual({
          ...Object.getOwnPropertyDescriptor(array, key),
          value: original,
        });
      }
      expect(Object.getOwnPropertyDescriptor(received.array, "length")).toEqual(
        Object.getOwnPropertyDescriptor(array, "length"),
      );
      expect(Object.getOwnPropertyDescriptor(received, "hidden")).toEqual({
        ...Object.getOwnPropertyDescriptor(input, "hidden"),
        value: original,
      });
    });
    try {
      consume(input);
      expect(array[3]).toBe(view);
      expect(input.hidden).toBe(view);
    } finally {
      await instance.dispose();
    }
  });

  it.each(["getter", "method"] as const)(
    "keeps containers opaque when their last own property is a %s",
    async (kind) => {
      const instance = new PluginInstance(`argument-${kind}`);
      const other = new PluginInstance("argument-foreign");
      const original = { read: () => 42 };
      const view = instance.wrap(original);
      const foreign = other.wrap(original);
      const invokeTrap = vi.fn(() => {
        throw new Error("caller code must not execute during restoration");
      });
      const proxy = new Proxy({}, { ownKeys: invokeTrap, getPrototypeOf: invokeTrap });
      class Caller {
        handle = view;
      }
      const caller = new Caller();
      const opaque = { nested: { handle: view } };
      Object.defineProperty(
        opaque,
        Symbol("last"),
        kind === "getter" ? { get: invokeTrap } : { value: invokeTrap },
      );
      const input = { view, foreign, proxy, caller, opaque };
      const consume = instance.wrap((received: typeof input) => {
        expect(received.view).toBe(original);
        expect(received.foreign).toBe(foreign);
        expect(received.proxy).toBe(proxy);
        expect(received.caller).toBe(caller);
        expect(received.opaque).toBe(opaque);
        expect(received.opaque.nested.handle).toBe(view);
        expect(invokeTrap).not.toHaveBeenCalled();
      });
      try {
        consume(input);
      } finally {
        await Promise.all([instance.dispose(), other.dispose()]);
      }
    },
  );

  it("observes newly inserted handles without caching unchanged classifications", async () => {
    const instance = new PluginInstance("argument-freshness");
    const original = { read: () => 42 };
    const view = instance.wrap(original);
    const input: { value?: typeof view } = {};
    const observations: (typeof input)[] = [];
    const consume = instance.wrap((received: typeof input) => {
      observations.push(received);
    });
    try {
      consume(input);
      input.value = view;
      consume(input);
      delete input.value;
      consume(input);
      expect(observations[0]).toBe(input);
      expect(observations[1]).not.toBe(input);
      expect(observations[1]?.value).toBe(original);
      expect(observations[2]).toBe(input);
      await instance.dispose();
      expect(() => consume(input)).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });
});
