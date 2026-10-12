import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { isPluginJsonValue } from "./host-hook-json.js";

describe("plugin host hook JSON values", () => {
  it("validates plugin-owned JSON values as plain JSON-compatible data", () => {
    expect(
      isPluginJsonValue({
        state: "waiting",
        attempts: 1,
        nested: [{ ok: true }, null],
      }),
    ).toBe(true);
    expect(isPluginJsonValue({ value: Number.NaN })).toBe(false);
    expect(isPluginJsonValue({ value: undefined })).toBe(false);
    expect(isPluginJsonValue(new Date(0))).toBe(false);
    expect(isPluginJsonValue(new Map([["state", "waiting"]]))).toBe(false);
    expect(isPluginJsonValue({ value: "x".repeat(70 * 1024) })).toBe(false);
    expect(
      isPluginJsonValue(vm.runInNewContext("({ state: 'waiting', nested: [{ ok: true }] })")),
    ).toBe(true);
    expect(isPluginJsonValue(vm.runInNewContext("new (class PluginValue { })()"))).toBe(false);
  });
});
