// Control UI tests cover array prototype polyfills.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// We dynamically import the polyfill module per test so each test can
// observe the side effects of its installation, then clean up afterwards.
const POLYFILL_LOADER = "../array-prototype-polyfills.ts";

async function loadPolyfillFresh(): Promise<void> {
  // The query string differs per test so the module is re-evaluated and
  // the install guards re-run.
  await import(`${POLYFILL_LOADER}?t=${Date.now()}-${Math.random()}`);
}

function removeMethod(target: object, key: string): void {
  const proto = target as unknown as Record<string, unknown>;
  if (typeof proto[key] === "undefined") return;
  delete proto[key];
}

describe("array-prototype-polyfills", () => {
  beforeEach(async () => {
    // Strip the patched methods so the polyfill must reinstall them.
    removeMethod(Array.prototype, "toSorted");
    removeMethod(Array.prototype, "toReversed");
    removeMethod(Array.prototype, "toSpliced");
    removeMethod(Array.prototype, "with");
    removeMethod(Array.prototype, "findLast");
    removeMethod(Array.prototype, "findLastIndex");
    removeMethod(Object, "hasOwn");
    await loadPolyfillFresh();
  });

  afterEach(() => {
    removeMethod(Array.prototype, "toSorted");
    removeMethod(Array.prototype, "toReversed");
    removeMethod(Array.prototype, "toSpliced");
    removeMethod(Array.prototype, "with");
    removeMethod(Array.prototype, "findLast");
    removeMethod(Array.prototype, "findLastIndex");
    removeMethod(Object, "hasOwn");
  });

  it("installs a non-mutating toSorted that mirrors the native ordering", () => {
    const input = [3, 1, 2];
    const sorted = input.toSorted((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    expect(input).toEqual([3, 1, 2]);
  });

  it("installs a non-mutating toReversed", () => {
    const input = [1, 2, 3];
    const reversed = input.toReversed();
    expect(reversed).toEqual([3, 2, 1]);
    expect(input).toEqual([1, 2, 3]);
  });

  it("installs a non-mutating toSpliced with insertion semantics", () => {
    const input = [1, 2, 3, 4];
    const result = input.toSpliced(1, 2, 9, 10);
    expect(result).toEqual([1, 9, 10, 4]);
    expect(input).toEqual([1, 2, 3, 4]);
  });

  it("installs Array.prototype.with that returns a new array", () => {
    const input = [1, 2, 3];
    const result = input.with(1, 99);
    expect(result).toEqual([1, 99, 3]);
    expect(input).toEqual([1, 2, 3]);
  });

  it("installs Array.prototype.with that supports negative indices", () => {
    const input = [1, 2, 3];
    const result = input.with(-1, 99);
    expect(result).toEqual([1, 2, 99]);
    expect(input).toEqual([1, 2, 3]);
  });

  it("installs Array.prototype.findLast that walks from the end", () => {
    const input = [1, 2, 3, 4];
    const result = input.findLast((n) => n % 2 === 0);
    expect(result).toBe(4);
  });

  it("installs Array.prototype.findLastIndex that returns -1 when missing", () => {
    const input = [1, 2, 3];
    expect(input.findLastIndex((n) => n > 10)).toBe(-1);
    expect(input.findLastIndex((n) => n === 2)).toBe(1);
  });

  it("installs Object.hasOwn that defers to hasOwnProperty", () => {
    const obj = { foo: 1 };
    expect(Object.hasOwn(obj, "foo")).toBe(true);
    expect(Object.hasOwn(obj, "bar")).toBe(false);
  });

  it("is a no-op when the native methods are already present", async () => {
    // After the initial beforeEach install, restore a sentinel that
    // pretends to be the native implementation and re-import the
    // polyfill. The install guard should leave the sentinel in place.
    const sentinel = function (this: unknown[]): unknown[] {
      return ["sentinel"];
    } as unknown as () => unknown[];
    (Array.prototype as unknown as Record<string, unknown>).toSorted = sentinel;
    await loadPolyfillFresh();
    const result = [3, 1, 2].toSorted();
    expect(result).toEqual(["sentinel"]);
  });
});
