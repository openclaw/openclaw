import { describe, expect, it, vi } from "vitest";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData, isPlainData } from "./immutable-data.js";

describe("immutable plain data", () => {
  it("inspects mutable plain data without freezing or memoizing it", () => {
    const value = { child: { field: 1 } };
    expect(isPlainData(value)).toBe(true);
    expect(isDeeplyFrozenPlainData(value)).toBe(false);
    Object.defineProperty(value.child, "field", { get: () => 2 });
    expect(isPlainData(value)).toBe(false);
    expect(Object.isFrozen(value)).toBe(false);
  });

  it("freezes shared and cyclic snapshots without retaining mutable aliases", () => {
    const child = { value: 1 };
    const snapshot = { child, children: [child], self: {} };
    snapshot.self = snapshot;
    expect(isDeeplyFrozenPlainData(snapshot)).toBe(false);
    expect(freezeJsonSnapshot(snapshot)).toBe(snapshot);
    expect(isDeeplyFrozenPlainData(snapshot)).toBe(true);
    expect(isDeeplyFrozenPlainData(child)).toBe(true);
    expect(isPlainData(snapshot.children)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(snapshot.children)).toBe(true);
    expect(() => {
      child.value = 2;
    }).toThrow(TypeError);
    expect(isDeeplyFrozenPlainData({ child })).toBe(false);
    const republished = freezeJsonSnapshot({ child, children: snapshot.children });
    expect(republished.child).toBe(child);
    expect(republished.children).toBe(snapshot.children);
    expect(isDeeplyFrozenPlainData(republished)).toBe(true);
  });

  it("freezes deeply nested snapshots without using the call stack", () => {
    let snapshot: { child?: object } = {};
    for (let depth = 0; depth < 12_000; depth++) {
      snapshot = { child: snapshot };
    }
    freezeJsonSnapshot(snapshot);
    expect(isDeeplyFrozenPlainData(snapshot)).toBe(true);
  });

  it("never classifies opaque or accessor-bearing graphs as immutable plain data", () => {
    const getter = vi.fn(() => ({ mutable: true }));
    const proxyTrap = vi.fn(() => {
      throw new Error("opaque proxy visited");
    });
    for (const opaque of [
      new Date(),
      new Map(),
      () => 1,
      new Proxy({}, { getPrototypeOf: proxyTrap, ownKeys: proxyTrap, isExtensible: proxyTrap }),
    ]) {
      expect(isDeeplyFrozenPlainData(opaque)).toBe(false);
      const snapshot = { child: { opaque }, valid: { value: 1 } };
      freezeJsonSnapshot(snapshot);
      expect(Object.isFrozen(snapshot.valid)).toBe(true);
      expect(isDeeplyFrozenPlainData(snapshot)).toBe(false);
      expect(isDeeplyFrozenPlainData(snapshot.child)).toBe(false);
    }
    const accessor = Object.defineProperty({}, "child", { get: getter });
    freezeJsonSnapshot(accessor);
    expect(isDeeplyFrozenPlainData(accessor)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(proxyTrap).not.toHaveBeenCalled();
  });

  it("checks every member of a frozen cycle before accepting it", () => {
    const mutable = { value: 1 };
    const root = { child: {}, mutable };
    root.child = Object.freeze({ root });
    Object.freeze(root);
    expect(isDeeplyFrozenPlainData(root)).toBe(false);
    mutable.value = 2;
    expect(isDeeplyFrozenPlainData(root.child)).toBe(false);
    Object.freeze(mutable);
    expect(isDeeplyFrozenPlainData(root)).toBe(true);
    expect(isDeeplyFrozenPlainData(root.child)).toBe(true);
  });

  it("does not trust frozen descendants that lead back to an opaque member", () => {
    const root = { child: {}, opaque: new Map([["key", { mutable: true }]]) };
    root.child = { root };
    freezeJsonSnapshot(root);
    expect(Object.isFrozen(root.child)).toBe(true);
    expect(isDeeplyFrozenPlainData(root)).toBe(false);
    expect(isDeeplyFrozenPlainData(root.child)).toBe(false);
    expect(isDeeplyFrozenPlainData(freezeJsonSnapshot({ child: root.child }))).toBe(false);
    root.opaque.get("key")!.mutable = false;
    expect(root.opaque.get("key")).toEqual({ mutable: false });
  });
});
