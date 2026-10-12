// Plugin compatibility registry tests cover compatibility metadata loading and validation.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { listPluginCompatRecords, type PluginCompatCode } from "./registry.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const removalDatePendingCompatCodes = new Set<PluginCompatCode>([
  "plugin-sdk-tool-plugin-public-demotion",
  "agent-harness-sdk-alias",
  "plugin-sdk-shipped-channel-setup-exports",
]);
function expectNonEmptyStringList(values: readonly string[], label: string) {
  expect(values, label).toEqual([expect.stringMatching(/\S/u), ...values.slice(1)]);
  for (const value of values) {
    expect(value, label).toMatch(/\S/u);
  }
}

describe("plugin compatibility registry", () => {
  it("keeps every record actionable", () => {
    for (const record of listPluginCompatRecords()) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.docsPath, record.code).toMatch(/^\//u);
      if (record.status === "deprecated") {
        expect(record.deprecated, record.code).toMatch(datePattern);
        expect(record.warningStarts, record.code).toMatch(datePattern);
        if (record.removalGate !== undefined) {
          expect(record.removalGate, record.code).toBe("next-plugin-sdk-major");
          expect(record.removeAfter, record.code).toBeUndefined();
        } else if (removalDatePendingCompatCodes.has(record.code)) {
          expect(record.removeAfter, record.code).toBeUndefined();
        } else {
          expect(record.removeAfter, record.code).toMatch(datePattern);
        }
        expect(record.replacement, record.code).toMatch(/\S/u);
      }
      expectNonEmptyStringList(record.surfaces, `${record.code}: surfaces`);
      expectNonEmptyStringList(record.diagnostics, `${record.code}: diagnostics`);
      expectNonEmptyStringList(record.tests, `${record.code}: tests`);
      for (const testPath of record.tests) {
        expect(fs.existsSync(testPath), `${record.code}: ${testPath}`).toBe(true);
      }
    }
  });
});
