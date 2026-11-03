// Verifies config merge patches reject prototype pollution inputs.
import { describe, it, expect } from "vitest";
import { applyMergePatch } from "./merge-patch.js";
import { collectBaseArrayPaths } from "./patch-replace-paths.js";

describe("applyMergePatch prototype pollution guard", () => {
  it("ignores __proto__ in nested patches", () => {
    const base = { nested: { x: 1 } };
    const patch = JSON.parse('{"nested": {"__proto__": {"polluted": true}, "y": 2}}');
    const result = applyMergePatch(base, patch) as { nested: Record<string, unknown> };
    expect(result.nested.y).toBe(2);
    expect(result.nested.x).toBe(1);
    expect(Object.hasOwn(result.nested, "__proto__")).toBe(false);
    expect(result.nested.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("allows prototype-like names only as direct browser profile keys", () => {
    const names = ["constructor", "prototype"] as const;
    const profile = {
      cdpPort: 18801,
      color: "#0066CC",
      constructor: { polluted: true },
      prototype: { polluted: true },
    };
    const result = applyMergePatch(
      { browser: { profiles: {} } },
      {
        constructor: { polluted: true },
        browser: {
          prototype: { polluted: true },
          profiles: Object.fromEntries(names.map((name) => [name, profile])),
        },
      },
    ) as { browser?: { profiles?: Record<string, Record<string, unknown>> } };

    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(Object.hasOwn(result.browser ?? {}, "prototype")).toBe(false);
    const profiles = result.browser?.profiles ?? {};
    for (const name of names) {
      expect(profiles[name]?.cdpPort).toBe(18801);
      expect(Object.hasOwn(profiles[name] ?? {}, "constructor")).toBe(false);
      expect(Object.hasOwn(profiles[name] ?? {}, "prototype")).toBe(false);
    }
    const removed = applyMergePatch(result, {
      browser: { profiles: { constructor: null, prototype: null } },
    }) as { browser?: { profiles?: Record<string, unknown> } };
    expect(Object.keys(removed.browser?.profiles ?? {})).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("merge-patch array deletion intent", () => {
  it("ignores non-object config values", () => {
    expect(collectBaseArrayPaths("value", "settings")).toEqual([]);
  });

  it("shares the exact browser-profile reserved-key exception with merge patches", () => {
    const base = JSON.parse(`{
      "__proto__": [], "constructor": [], "prototype": [],
      "browser": {
        "constructor": [],
        "profiles": {
          "__proto__": [],
          "constructor": { "values": [], "constructor": [], "prototype": [], "__proto__": [] },
          "prototype": { "values": [] },
          "regular": { "nested": { "constructor": [], "values": [] } }
        }
      }
    }`);
    expect(collectBaseArrayPaths(base, "")).toEqual([
      "browser.profiles.constructor.values",
      "browser.profiles.prototype.values",
      "browser.profiles.regular.nested.values",
    ]);
  });
});
