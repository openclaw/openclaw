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
    expect([isPlainData(value), isDeeplyFrozenPlainData(value)]).toEqual([true, false]);
    Object.defineProperty(value.child, "field", { get: () => 2 });
    expect([isPlainData(value), Object.isFrozen(value)]).toEqual([false, false]);
  });

  it.each([freezeJson, freezeTrusted])("%s freezes shallow-frozen shared cycles", (freeze) => {
    const child = { value: 1 };
    const snapshot = { child, children: [child], self: {} };
    snapshot.self = snapshot;
    Object.freeze(snapshot);
    expect(freeze(snapshot)).toBe(snapshot);
    expectClassification(true, snapshot, child);
    expect(() => child.value++).toThrow(TypeError);
    const republished = freeze({ child });
    expect(republished.child).toBe(child);
    expectClassification(true, republished);
    expect(freezeJson({ snapshot }).snapshot).toBe(snapshot);
  });

  it("queues only new descendants when freezing a shared snapshot tail", () => {
    const retained = freezeTrusted([{ nested: { value: 1 } }]);
    const appended = { nested: { value: 3 } };
    const next = [...retained, appended];
    const push = Array.prototype.push;
    let revisited = false;
    // Spy bookkeeping also uses push; count directly and restore before assertions.
    /* eslint-disable no-extend-native */
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      revisited ||= items.some((item) => item === retained[0]);
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
    expect([next, appended, appended.nested].map(Object.isFrozen)).toEqual([true, true, true]);
  });

  it.each([freezeJson, freezeTrusted])("%s freezes oversized cycles", (freeze) => {
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
  });

  it("rejects opaque/accessor graphs without invoking traps", () => {
    const trap = vi.fn();
    const proxy = new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, isExtensible: trap });
    for (const opaque of [new Date(), new Map(), () => 1, proxy]) {
      expectClassification(false, opaque);
      const snapshot = { child: { opaque }, valid: { value: 1 } };
      freezeJson(snapshot);
      expect(Object.isFrozen(snapshot.valid)).toBe(true);
      expectClassification(false, snapshot, snapshot.child);
    }
    const accessor = Object.defineProperty({}, "child", { get: trap });
    freezeJson(accessor);
    expectClassification(false, accessor);
    expect(trap).not.toHaveBeenCalled();
  });

  it("checks every member of a frozen cycle before accepting it", () => {
    const root = { child: {}, mutable: { value: 1 } };
    root.child = Object.freeze({ root });
    Object.freeze(root);
    expectClassification(false, root);
    root.mutable.value = 2;
    expectClassification(false, root.child);
    Object.freeze(root.mutable);
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
