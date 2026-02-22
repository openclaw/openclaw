import { describe, it, expect } from "vitest";
import { mergeConfigSection } from "./merge-config.js";

describe("mergeConfigSection prototype pollution guard", () => {
  const cases = [
    {
      key: "__proto__",
      makePatch: () => JSON.parse('{"__proto__": {"polluted": true}, "b": "2"}'),
    },
    {
      key: "constructor",
      makePatch: () => ({ constructor: { polluted: true }, b: "2" }),
    },
    {
      key: "prototype",
      makePatch: () => ({ prototype: { polluted: true }, b: "2" }),
    },
  ] as const;

  for (const testCase of cases) {
    it(`ignores ${testCase.key} key in patch`, () => {
      const base = { a: "1" } as Record<string, unknown>;
      const patch = testCase.makePatch() as Record<string, unknown>;
      const result = mergeConfigSection(base, patch);

      expect(result.b).toBe("2");
      expect(result.a).toBe("1");
      expect(Object.prototype.hasOwnProperty.call(result, testCase.key)).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  }
});
