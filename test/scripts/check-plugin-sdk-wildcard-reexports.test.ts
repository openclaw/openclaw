// Check Plugin Sdk Wildcard Reexports tests cover check plugin sdk wildcard reexports script behavior.
import { describe, expect, it } from "vitest";
import { findPluginSdkWildcardReexports } from "../../scripts/check-plugin-sdk-wildcard-reexports.mjs";

describe("check-plugin-sdk-wildcard-reexports", () => {
  it("flags wildcard re-exports from plugin-sdk subpaths", () => {
    expect(
      findPluginSdkWildcardReexports(
        [
          'export * from "openclaw/plugin-sdk/foo";',
<<<<<<< HEAD
          'export * as sdk from "openclaw/plugin-sdk/foo";',
          'export type * from "openclaw/plugin-sdk/bar";',
          'export type * as sdkTypes from "openclaw/plugin-sdk/bar";',
=======
          'export type * from "openclaw/plugin-sdk/bar";',
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
          'export { named } from "openclaw/plugin-sdk/foo";',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, text: 'export * from "openclaw/plugin-sdk/foo";' },
<<<<<<< HEAD
      { line: 2, text: 'export * as sdk from "openclaw/plugin-sdk/foo";' },
      { line: 3, text: 'export type * from "openclaw/plugin-sdk/bar";' },
      { line: 4, text: 'export type * as sdkTypes from "openclaw/plugin-sdk/bar";' },
=======
      { line: 2, text: 'export type * from "openclaw/plugin-sdk/bar";' },
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ]);
  });

  it("allows explicit SDK exports and local wildcard barrels", () => {
    expect(
      findPluginSdkWildcardReexports(
        [
          'export { named } from "openclaw/plugin-sdk/foo";',
          'export type { Named } from "openclaw/plugin-sdk/foo";',
          'export * from "./src/runtime-api.js";',
<<<<<<< HEAD
          'export * as runtime from "./src/runtime-api.js";',
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        ].join("\n"),
      ),
    ).toStrictEqual([]);
  });
});
