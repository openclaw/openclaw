import { expect, it } from "vitest";
import * as schema from "../../scripts/check-native-state-schema-version.mjs";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";

it("keeps the checked-in Swift fixture and production contracts aligned", () => {
  expect(schema.checkNativeStateSchemaVersion()).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
});

it.each([
  [5, 9, 9, "Native state schema version drift: Swift supports 5, TypeScript owns 9"],
  [36, 36, 35, "Native state schema fixture drift: Swift tests seed 35, TypeScript owns 36"],
] as const)("detects drift: Swift %i, TS %i, fixture %i", (swift, typescript, fixture, message) => {
  expect(() =>
    schema.compareNativeStateSchemaVersions({
      swiftSource: `private static let maximumSupportedSchemaVersion: Int64 = ${swift}\n`,
      typescriptSource: `export const OPENCLAW_STATE_SCHEMA_VERSION = ${typescript};\n`,
      swiftFixtureSource: `private static let currentSharedSchemaVersion: Int64 = ${fixture}\n`,
    }),
  ).toThrow(message);
});
