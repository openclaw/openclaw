import { describe, expect, it } from "vitest";
import {
  compareStableReleases,
  evaluatePluginSdkShippedSurface,
  parsePluginSdkShippedSurface,
  typedPluginSdkSubpaths,
  type PluginSdkShippedSurface,
} from "../../scripts/lib/plugin-sdk-shipped-surface.mts";
import type { PluginCompatRecord } from "../../src/plugins/compat/types.js";

const inventory: PluginSdkShippedSurface = {
  schema: "openclaw.plugin-sdk-shipped-surface/v1",
  release: "v2026.9.8",
  commit: "f".repeat(40),
  entrypoints: { messaging: ["receive", "send"] },
};
const now = "2026-10-02";
const surface = "openclaw/plugin-sdk/messaging";
const missingName = new Map([["messaging", ["receive"]]]);
const record: PluginCompatRecord = {
  code: "fixture.messaging",
  status: "removed",
  owner: "sdk",
  introduced: "2026.9.8",
  docsPath: "/plugins/sdk-migration",
  surfaces: [surface],
  diagnostics: [],
  tests: [],
};

// Protect the public compatibility window independently of compiler setup and budget accounting.
describe("shipped Plugin SDK removal authorization", () => {
  it("reports both missing entrypoints and missing named exports", () => {
    expect(evaluatePluginSdkShippedSurface(inventory, new Map(), [], now)).toEqual([
      { subpath: "messaging", missingSubpath: true, names: ["receive", "send"] },
    ]);
    expect(evaluatePluginSdkShippedSurface(inventory, missingName, [], now)).toEqual([
      { subpath: "messaging", missingSubpath: false, names: ["send"] },
    ]);
    expect(
      evaluatePluginSdkShippedSurface(
        inventory,
        new Map(Object.entries(inventory.entrypoints)),
        [],
        now,
      ),
    ).toEqual([]);
  });

  it.each([
    ["future date", { removeAfter: "2026-10-03" }],
    ["final compatibility day", { removeAfter: now }],
    ["major gate alone", { removalGate: "next-plugin-sdk-major" }],
    ["invalid calendar date", { removeAfter: "2026-02-30" }],
    ["active record", { status: "active", removeAfter: "2026-10-01" }],
    ["bare name", { surfaces: ["send"], removeAfter: "2026-10-01" }],
    [
      "different entrypoint",
      { surfaces: ["openclaw/plugin-sdk/other.send"], removeAfter: "2026-10-01" },
    ],
  ] satisfies [string, Partial<PluginCompatRecord>][])(
    "does not authorize removal with %s",
    (_, overrides) => {
      expect(
        evaluatePluginSdkShippedSurface(inventory, missingName, [{ ...record, ...overrides }], now),
      ).toEqual([{ subpath: "messaging", missingSubpath: false, names: ["send"] }]);
    },
  );

  it.each(["deprecated", "removal-pending", "removed"] as const)(
    "honors a reached subpath window for %s records",
    (status) => {
      expect(
        evaluatePluginSdkShippedSurface(
          inventory,
          new Map(),
          [{ ...record, status, removeAfter: "2026-10-01" }],
          now,
        ),
      ).toEqual([]);
    },
  );

  it.each([`${surface}.send`, `${surface} send`])(
    "honors reached qualified-name window %s without authorizing the entire subpath",
    (qualified) => {
      const records = [{ ...record, surfaces: [qualified], removeAfter: "2026-10-01" }];
      expect(evaluatePluginSdkShippedSurface(inventory, missingName, records, now)).toEqual([]);
      expect(evaluatePluginSdkShippedSurface(inventory, new Map(), records, now)).toEqual([
        { subpath: "messaging", missingSubpath: true, names: ["receive"] },
      ]);
    },
  );
});

describe("shipped inventory inputs", () => {
  it("excludes packaged runtime facades without declarations", () => {
    expect(
      typedPluginSdkSubpaths({
        exports: {
          "./plugin-sdk/messaging": {
            types: "./dist/messaging.d.ts",
            default: "./dist/messaging.js",
          },
          "./plugin-sdk/private-runtime": { default: "./dist/private-runtime.js" },
          "./other": { types: "./dist/other.d.ts" },
        },
      }),
    ).toEqual(["messaging"]);
  });

  it.each([
    {},
    { ...inventory, entrypoints: [] },
    { ...inventory, entrypoints: {} },
    { ...inventory, entrypoints: { messaging: [4] } },
    { ...inventory, commit: "main" },
  ])("rejects malformed inventory %j", (value) => {
    expect(() => parsePluginSdkShippedSurface(value)).toThrow("Malformed");
  });

  it("orders numeric stable versions and rejects prereleases", () => {
    expect(compareStableReleases("v2026.10.1", "v2026.9.8")).toBe(1);
    expect(compareStableReleases("v2026.9.8", "v2026.10.1")).toBe(-1);
    expect(compareStableReleases("v2026.9.8", "v2026.9.8")).toBe(0);
    for (const tag of ["v2026.10.1-beta.1", "v2026.10.1-alpha.1", "v2026.10.1-rc.1"]) {
      expect(() => compareStableReleases(tag, inventory.release)).toThrow("stable release tag");
    }
  });
});
