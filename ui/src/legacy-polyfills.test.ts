import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
const indexHtml = readFileSync(indexHtmlPath, "utf8");
const polyfillScript =
  /<script\b[^>]*\bdata-openclaw-legacy-polyfills\b[^>]*>([^]*?)<\/script>/u.exec(indexHtml)?.[1];

// Runs the classic inline script from index.html the way the browser does.
function installLegacyBrowserPolyfills() {
  if (!polyfillScript) {
    throw new Error("index.html is missing the legacy polyfill script");
  }
  new Function(polyfillScript)();
}

const ITERATOR_HELPERS = [
  "map",
  "filter",
  "take",
  "drop",
  "flatMap",
  "reduce",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
] as const;

const iteratorPrototype = Object.getPrototypeOf(
  Object.getPrototypeOf([][Symbol.iterator]()),
) as Record<string, unknown>;

type Restore = () => void;
const restores: Restore[] = [];

// Removes the property from whichever object in the chain owns it (jsdom's URL
// inherits its statics), and fails loudly if the engine still exposes it.
function removeOwn(target: object, name: string) {
  for (let owner: object | null = target; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) {
      const definedOn = owner;
      delete (definedOn as Record<string, unknown>)[name];
      restores.push(() => {
        Object.defineProperty(definedOn, name, descriptor);
      });
    }
  }
  expect(name in target).toBe(false);
}

// Mirrors an engine without the built-ins (for example Chromium 114).
function removeModernBuiltins() {
  removeOwn(Promise, "withResolvers");
  removeOwn(AbortSignal, "any");
  removeOwn(URL, "parse");
  removeOwn(URL, "canParse");
  removeOwn(globalThis, "Iterator");
  for (const name of ITERATOR_HELPERS) {
    removeOwn(iteratorPrototype, name);
  }
}

afterEach(() => {
  for (const restore of restores.splice(0).toReversed()) {
    restore();
  }
});

describe("index.html legacy built-in fallbacks", () => {
  it("leaves native built-ins untouched on current engines", () => {
    const nativeWithResolvers = Promise.withResolvers;
    const nativeMap = iteratorPrototype.map;

    installLegacyBrowserPolyfills();
    expect(Promise.withResolvers).toBe(nativeWithResolvers);
    expect(iteratorPrototype.map).toBe(nativeMap);
  });

  describe("on an engine without the built-ins", () => {
    it("installs every fallback non-enumerably", () => {
      removeModernBuiltins();
      expect(Promise.withResolvers).toBeUndefined();

      installLegacyBrowserPolyfills();

      for (const [target, name] of [
        [Promise, "withResolvers"],
        [AbortSignal, "any"],
        [URL, "parse"],
        [URL, "canParse"],
        [globalThis, "Iterator"],
        ...ITERATOR_HELPERS.map((helper) => [iteratorPrototype, helper] as const),
      ] as const) {
        expect(typeof (target as Record<string, unknown>)[name]).toBe("function");
      }
      expect(typeof Iterator.from).toBe("function");
      expect(Object.getOwnPropertyDescriptor(Promise, "withResolvers")?.enumerable).toBe(false);
      expect(Object.keys(iteratorPrototype)).toEqual([]);
    });

    it("resolves Promise.withResolvers deferreds", async () => {
      removeModernBuiltins();
      installLegacyBrowserPolyfills();

      const resolved = Promise.withResolvers<number>();
      resolved.resolve(5);
      await expect(resolved.promise).resolves.toBe(5);

      const rejected = Promise.withResolvers<number>();
      rejected.reject(new Error("nope"));
      await expect(rejected.promise).rejects.toThrow("nope");
    });

    it("aborts AbortSignal.any with the first source reason", () => {
      removeModernBuiltins();
      installLegacyBrowserPolyfills();

      const first = new AbortController();
      const second = new AbortController();
      const combined = AbortSignal.any([first.signal, second.signal]);
      expect(combined.aborted).toBe(false);
      second.abort("second");
      first.abort("first");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("second");

      const already = new AbortController();
      already.abort("early");
      expect(AbortSignal.any([new AbortController().signal, already.signal]).reason).toBe("early");
    });

    it("parses URLs without throwing", () => {
      removeModernBuiltins();
      installLegacyBrowserPolyfills();

      expect(URL.parse("https://example.test/path")?.hostname).toBe("example.test");
      expect(URL.parse("/x", "https://example.test/")?.href).toBe("https://example.test/x");
      expect(URL.parse("not a url")).toBeNull();
      expect(URL.canParse("https://example.test")).toBe(true);
      expect(URL.canParse("/relative", "https://example.test")).toBe(true);
      expect(URL.canParse("::")).toBe(false);
    });

    it("supports chained iterator helpers on built-in and generator iterators", () => {
      removeModernBuiltins();
      installLegacyBrowserPolyfills();

      const identities = new Map([
        [1, { agentId: "a" }],
        [2, { agentId: "b" }],
      ]);
      expect(
        Object.fromEntries(identities.entries().map(([key, value]) => [value.agentId, key])),
      ).toEqual({ a: 1, b: 2 });
      expect(
        identities
          .keys()
          .filter((key) => key > 1)
          .toArray(),
      ).toEqual([2]);
      expect(
        identities
          .keys()
          .flatMap((key) => [key, key])
          .toArray(),
      ).toEqual([1, 1, 2, 2]);
      expect([1, 2, 3, 4].values().drop(1).take(2).toArray()).toEqual([2, 3]);
      expect([1, 2, 3].values().reduce((sum, value) => sum + value)).toBe(6);
      expect([].values().reduce((sum: number, value: number) => sum + value, 7)).toBe(7);
      expect(() => [].values().reduce((sum: number, value: number) => sum + value)).toThrow(
        TypeError,
      );

      let seen = 0;
      [1, 2].values().forEach((value) => {
        seen += value;
      });
      expect(seen).toBe(3);
      expect([1, 2].values().some((value) => value === 2)).toBe(true);
      expect([1, 2].values().every((value) => value === 2)).toBe(false);
      expect([1, 2].values().find((value) => value > 1)).toBe(2);

      function* numbers() {
        yield 1;
        yield 2;
      }
      expect(
        numbers()
          .map((value) => value * 10)
          .toArray(),
      ).toEqual([10, 20]);
    });

    it("closes the source iterator when a helper stops early", () => {
      removeModernBuiltins();
      installLegacyBrowserPolyfills();

      let closed = false;
      function* source() {
        try {
          yield 1;
          yield 2;
          yield 3;
        } finally {
          closed = true;
        }
      }
      expect(source().find((value) => value === 1)).toBe(1);
      expect(closed).toBe(true);
    });

    it("exposes a global Iterator with Iterator.from", () => {
      removeModernBuiltins();
      installLegacyBrowserPolyfills();

      expect([].values()).toBeInstanceOf(Iterator);
      let next = 0;
      const plain = {
        next: () => (next < 2 ? { value: next++, done: false } : { value: undefined, done: true }),
      };
      expect(Iterator.from(plain).toArray()).toEqual([0, 1]);
      const native = [1].values();
      expect(Iterator.from(native)).toBe(native);
    });
  });
});
