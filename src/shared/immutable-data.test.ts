import { describe, expect, it, vi } from "vitest";
import {
  freezeJsonSnapshot as freezeJson,
  freezeTrustedJsonSnapshot as freezeTrusted,
  isDeeplyFrozenPlainData,
  isPlainData,
} from "./immutable-data.js";

function expectClassification(frozen: boolean, ...values: unknown[]) {
  values.forEach((value) => expect(isDeeplyFrozenPlainData(value)).toBe(frozen));
}

describe("immutable plain data", () => {
  it("inspects mutable data without freezing or memoizing it", () => {
    const value = { child: { field: 1 } };
    expect(isPlainData(value)).toBe(true);
    expectClassification(false, value);
    Object.defineProperty(value.child, "field", { get: () => 2 });
    expect([isPlainData(value), Object.isFrozen(value)]).toEqual([false, false]);
  });

  it.each(["inspected", "trusted", "shallow trusted"])("freezes %s shared cycles", (mode) => {
    const freeze = mode === "inspected" ? freezeJson : freezeTrusted;
    const child = { value: 1 };
    const known = freezeJson({ value: 1 });
    const snapshot = { child, known, children: [child], self: {} };
    snapshot.self = snapshot;
    if (mode === "shallow trusted") {
      Object.freeze(snapshot);
    }
    expectClassification(false, snapshot);
    expect(freeze(snapshot)).toBe(snapshot);
    expectClassification(true, snapshot, child);
    expect(isPlainData(snapshot.children)).toBe(true);
    expect([child, snapshot.children].map(Object.isFrozen)).toEqual([true, true]);
    expect(() => {
      child.value = 2;
    }).toThrow(TypeError);
    expectClassification(false, { child });
    const republished = freeze({ child, children: snapshot.children });
    expect(republished.child).toBe(child);
    expect(republished.children).toBe(snapshot.children);
    expectClassification(true, republished);
    expect(snapshot.known).toBe(known);
    expect(freezeJson({ snapshot }).snapshot).toBe(snapshot);
  });

  it("queues only new descendants when freezing a shared snapshot tail", () => {
    const retained = freezeTrusted([{ nested: { value: 1 } }, { nested: { value: 2 } }]);
    const appended = { nested: { value: 3 } };
    const next = [...retained, appended];
    const push = Array.prototype.push;
    let revisited = false;
    // Spy bookkeeping also uses push; count directly and restore before assertions.
    /* eslint-disable no-extend-native */
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      revisited ||= items.some((item) => item === retained[0] || item === retained[1]);
      return Reflect.apply(push, this, items);
    };
    try {
      freezeTrusted(next);
    } finally {
      Array.prototype.push = push;
    }
    /* eslint-enable no-extend-native */
    expect(revisited).toBe(false);
    expect(next[0]).toBe(retained[0]);
    expect(next[1]).toBe(retained[1]);
    expect([next, appended, appended.nested].map(Object.isFrozen)).toEqual([true, true, true]);
    expect(() => {
      appended.nested.value = 4;
    }).toThrow(TypeError);
  });

  it.each([freezeJson, freezeTrusted])(
    "%s freezes oversized cycles without recursion",
    (freeze) => {
      const leaf: { child?: object } = {};
      let snapshot = leaf;
      // Eviction must not discard cycle detection during a graph larger than the memo.
      for (let depth = 0; depth < 300_000; depth++) {
        snapshot = { child: snapshot };
      }
      leaf.child = snapshot;
      freeze(snapshot);
      expectClassification(true, snapshot, leaf);
      expect(Object.isFrozen(leaf)).toBe(true);
    },
  );

  it("rejects opaque/accessor graphs without invoking traps", () => {
    const getter = vi.fn(() => ({ mutable: true }));
    const proxyTrap = vi.fn(() => {
      throw new Error("opaque proxy visited");
    });
    const proxy = new Proxy(
      {},
      { getPrototypeOf: proxyTrap, ownKeys: proxyTrap, isExtensible: proxyTrap },
    );
    for (const opaque of [new Date(), new Map(), () => 1, proxy]) {
      expectClassification(false, opaque);
      const snapshot = { child: { opaque }, valid: { value: 1 } };
      freezeJson(snapshot);
      expect(Object.isFrozen(snapshot.valid)).toBe(true);
      expectClassification(false, snapshot, snapshot.child);
    }
    const accessor = Object.defineProperty({}, "child", { get: getter });
    freezeJson(accessor);
    expectClassification(false, accessor);
    expect([getter.mock.calls.length, proxyTrap.mock.calls.length]).toEqual([0, 0]);
  });

  it("checks every member of a frozen cycle before accepting it", () => {
    const mutable = { value: 1 };
    const root = { child: {}, mutable };
    root.child = Object.freeze({ root });
    Object.freeze(root);
    expectClassification(false, root);
    mutable.value = 2;
    expectClassification(false, root.child);
    Object.freeze(mutable);
    expectClassification(true, root, root.child);
  });

  it("rejects frozen descendants that cycle back to opaque members", () => {
    const root = { child: {}, opaque: new Map([["key", { mutable: true }]]) };
    root.child = { root };
    freezeJson(root);
    expect(Object.isFrozen(root.child)).toBe(true);
    expectClassification(false, root, root.child);
    expectClassification(false, freezeJson({ child: root.child }));
    root.opaque.get("key")!.mutable = false;
    expect(root.opaque.get("key")).toEqual({ mutable: false });
  });
});
