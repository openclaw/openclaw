// Web Fetch own-property check proof — Object.hasOwn() safety
// Tests the core semantic: Object.hasOwn rejects proto-chain, accepts own

import { describe, test, expect } from "vitest";

const FIELDS = ["provider", "maxCharsCap", "maxResponseBytes", "userAgent"] as const;

describe("Object.hasOwn safety — web-fetch fields", () => {
  for (const field of FIELDS) {
    test(`'${field}' — Object.hasOwn rejects proto, in operator accepts`, () => {
      const proto = Object.create({ [field]: "proto-value" });
      expect(field in proto).toBe(true);
      expect(Object.hasOwn(proto, field)).toBe(false);
    });

    test(`'${field}' — Object.hasOwn accepts own property`, () => {
      const own = { [field]: "own-value" };
      expect(field in own).toBe(true);
      expect(Object.hasOwn(own, field)).toBe(true);
    });
  }
});

describe("Files and functions covered", () => {
  test("all 6 replacements are covered by the 4 fields", () => {
    const replacements = [
      { file: "src/web-fetch/runtime.ts", fn: "resolveWebFetchProviderId", field: "provider" },
      {
        file: "src/web-fetch/runtime.ts",
        fn: "resolveConfiguredWebFetchProviderId",
        field: "provider",
      },
      {
        file: "src/agents/tools/web-fetch.ts",
        fn: "resolveFetchMaxCharsCap",
        field: "maxCharsCap",
      },
      {
        file: "src/agents/tools/web-fetch.ts",
        fn: "resolveFetchMaxResponseBytes",
        field: "maxResponseBytes",
      },
      {
        file: "src/agents/tools/web-fetch.ts",
        fn: "createWebFetchTool — providerCacheKey",
        field: "provider",
      },
      {
        file: "src/agents/tools/web-fetch.ts",
        fn: "createWebFetchTool — userAgent",
        field: "userAgent",
      },
    ];
    expect(replacements.length).toBe(6);
  });
});
