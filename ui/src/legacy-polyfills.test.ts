import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
const indexHtml = readFileSync(indexHtmlPath, "utf8");
const polyfillSource =
  /<script\b[^>]*\bdata-openclaw-legacy-polyfills\b[^>]*>([^]*?)<\/script>/u.exec(indexHtml)?.[1];
if (!polyfillSource) {
  throw new Error("index.html is missing the legacy polyfill script");
}
const polyfillScript = new vm.Script(polyfillSource, { filename: "index.html" });

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

// URL stand-in without the statics, so the fallbacks land here and never on the
// runner's URL.
class UrlWithoutStatics {
  readonly href: string;
  readonly hostname: string;

  constructor(url: string, base?: string) {
    const parsed = new URL(url, base);
    this.href = parsed.href;
    this.hostname = parsed.hostname;
  }
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

type LegacyRealm = {
  // Runs the classic inline script from index.html the way the browser does.
  installPolyfills: () => void;
  evaluate: (source: string) => unknown;
  Promise: { withResolvers: <T>() => Deferred<T> };
  URL: {
    parse: (url: string, base?: string) => UrlWithoutStatics | null;
    canParse: (url: string, base?: string) => boolean;
  };
  AbortSignal: { any: (signals: AbortSignal[]) => AbortSignal };
};

// Each test gets its own realm (own Promise, Iterator and iterator prototype),
// so nothing leaks into the shared jsdom window of the non-isolated UI runner.
function createRealm({ legacy }: { legacy: boolean }): LegacyRealm {
  const context = vm.createContext({
    URL: UrlWithoutStatics,
    AbortController,
    AbortSignal: {},
  });
  // Block-scoped, so snippets in one realm can reuse local names.
  const evaluate = (source: string): unknown => vm.runInContext(`{${source}\n}`, context);
  if (legacy) {
    // Mirrors an engine without the built-ins (for example Chromium 114).
    evaluate(`
      delete Promise.withResolvers;
      delete globalThis.Iterator;
      const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
      for (const name of ${JSON.stringify(ITERATOR_HELPERS)}) delete proto[name];
    `);
    expect(
      evaluate(
        "[typeof Promise.withResolvers, typeof globalThis.Iterator, typeof [].values().map].join()",
      ),
    ).toBe("undefined,undefined,undefined");
  }
  return {
    installPolyfills: () => {
      polyfillScript.runInContext(context);
    },
    evaluate,
    Promise: evaluate("Promise") as LegacyRealm["Promise"],
    URL: context.URL as LegacyRealm["URL"],
    AbortSignal: context.AbortSignal as LegacyRealm["AbortSignal"],
  };
}

const NATIVE_BUILTINS = [
  "Promise.withResolvers",
  "Iterator",
  "Object.getPrototypeOf(Object.getPrototypeOf([].values())).map",
];

describe("index.html legacy built-in fallbacks", () => {
  it("leaves native built-ins untouched on current engines", () => {
    const realm = createRealm({ legacy: false });
    const before = NATIVE_BUILTINS.map(realm.evaluate);
    for (const builtin of before) {
      expect(typeof builtin).toBe("function");
    }

    realm.installPolyfills();
    const after = NATIVE_BUILTINS.map(realm.evaluate);
    for (const [index, builtin] of before.entries()) {
      expect(after[index]).toBe(builtin);
    }
  });

  describe("on an engine without the built-ins", () => {
    it("installs every fallback non-enumerably", () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();

      expect(
        realm.evaluate(`
          const proto = Object.getPrototypeOf(Object.getPrototypeOf([].values()));
          const types = {
            withResolvers: typeof Promise.withResolvers,
            any: typeof AbortSignal.any,
            parse: typeof URL.parse,
            canParse: typeof URL.canParse,
            Iterator: typeof Iterator,
            from: typeof Iterator.from,
          };
          for (const name of ${JSON.stringify(ITERATOR_HELPERS)}) types[name] = typeof proto[name];
          JSON.stringify({
            types,
            enumerable: Object.getOwnPropertyDescriptor(Promise, "withResolvers").enumerable,
            protoKeys: Object.keys(proto),
          });
        `),
      ).toBe(
        JSON.stringify({
          types: Object.fromEntries(
            [
              "withResolvers",
              "any",
              "parse",
              "canParse",
              "Iterator",
              "from",
              ...ITERATOR_HELPERS,
            ].map((name) => [name, "function"]),
          ),
          enumerable: false,
          protoKeys: [],
        }),
      );
    });

    it("resolves Promise.withResolvers deferreds", async () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();
      const resolved = realm.Promise.withResolvers<number>();
      resolved.resolve(5);
      await expect(resolved.promise).resolves.toBe(5);

      const rejected = realm.Promise.withResolvers<number>();
      rejected.reject(new Error("nope"));
      await expect(rejected.promise).rejects.toThrow("nope");
    });

    it("aborts AbortSignal.any with the first source reason", () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();

      const first = new AbortController();
      const second = new AbortController();
      const combined = realm.AbortSignal.any([first.signal, second.signal]);
      expect(combined.aborted).toBe(false);
      second.abort("second");
      first.abort("first");
      expect(combined.aborted).toBe(true);
      expect(combined.reason).toBe("second");

      const already = new AbortController();
      already.abort("early");
      expect(realm.AbortSignal.any([new AbortController().signal, already.signal]).reason).toBe(
        "early",
      );
    });

    it("parses URLs without throwing", () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();

      expect(realm.URL.parse("https://example.test/path")?.hostname).toBe("example.test");
      expect(realm.URL.parse("/x", "https://example.test/")?.href).toBe("https://example.test/x");
      expect(realm.URL.parse("not a url")).toBeNull();
      expect(realm.URL.canParse("https://example.test")).toBe(true);
      expect(realm.URL.canParse("/relative", "https://example.test")).toBe(true);
      expect(realm.URL.canParse("::")).toBe(false);
    });

    it("supports chained iterator helpers on built-in and generator iterators", () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();

      expect(
        realm.evaluate(`
          const identities = new Map([
            [1, { agentId: "a" }],
            [2, { agentId: "b" }],
          ]);
          let seen = 0;
          [1, 2].values().forEach((value) => {
            seen += value;
          });
          let emptyReduceThrowsTypeError = false;
          try {
            [].values().reduce((sum, value) => sum + value);
          } catch (error) {
            emptyReduceThrowsTypeError = error instanceof TypeError;
          }
          function* numbers() {
            yield 1;
            yield 2;
          }
          JSON.stringify({
            entries: Object.fromEntries(
              identities.entries().map(([key, value]) => [value.agentId, key]),
            ),
            filtered: identities.keys().filter((key) => key > 1).toArray(),
            flatMapped: identities.keys().flatMap((key) => [key, key]).toArray(),
            dropTake: [1, 2, 3, 4].values().drop(1).take(2).toArray(),
            sum: [1, 2, 3].values().reduce((sum, value) => sum + value),
            seeded: [].values().reduce((sum, value) => sum + value, 7),
            emptyReduceThrowsTypeError,
            seen,
            some: [1, 2].values().some((value) => value === 2),
            every: [1, 2].values().every((value) => value === 2),
            found: [1, 2].values().find((value) => value > 1),
            generator: numbers().map((value) => value * 10).toArray(),
          });
        `),
      ).toBe(
        JSON.stringify({
          entries: { a: 1, b: 2 },
          filtered: [2],
          flatMapped: [1, 1, 2, 2],
          dropTake: [2, 3],
          sum: 6,
          seeded: 7,
          emptyReduceThrowsTypeError: true,
          seen: 3,
          some: true,
          every: false,
          found: 2,
          generator: [10, 20],
        }),
      );
    });

    it("closes the source iterator when a helper stops early", () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();

      expect(
        realm.evaluate(`
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
          JSON.stringify([source().find((value) => value === 1), closed]);
        `),
      ).toBe(JSON.stringify([1, true]));
    });

    it("exposes a global Iterator with Iterator.from", () => {
      const realm = createRealm({ legacy: true });
      realm.installPolyfills();

      expect(
        realm.evaluate(`
          let next = 0;
          const plain = {
            next: () => (next < 2 ? { value: next++, done: false } : { value: undefined, done: true }),
          };
          const native = [1].values();
          JSON.stringify([
            [].values() instanceof Iterator,
            Iterator.from(plain).toArray(),
            Iterator.from(native) === native,
          ]);
        `),
      ).toBe(JSON.stringify([true, [0, 1], true]));
    });
  });
});
