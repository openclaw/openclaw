import { describe, it, expect } from "vitest";
import { mergeConfigSection } from "./merge-config.js";

describe("mergeConfigSection prototype pollution guard", () => {
  it("ignores __proto__ keys in patch", () => {
    const base = { a: "1" } as Record<string, unknown>;
    const patch = JSON.parse('{"__proto__": {"polluted": true}, "b": "2"}');
    const result = mergeConfigSection(base, patch);
    expect(result.b).toBe("2");
    expect(result.a).toBe("1");
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores constructor key in patch", () => {
    const base = { a: "1" } as Record<string, unknown>;
    const patch = { constructor: { polluted: true }, b: "2" } as Record<string, unknown>;
    const result = mergeConfigSection(base, patch);
    expect(result.b).toBe("2");
    expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
  });
});
