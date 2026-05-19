import { describe, expect, it } from "vitest";
import type { GatewayThinkingLevelOption } from "../types.ts";
import { buildThinkingOptions } from "./session-controls.ts";

describe("buildThinkingOptions", () => {
  it("strips an explicit off level so the inherited entry is not duplicated", () => {
    const levels: GatewayThinkingLevelOption[] = [
      { id: "off", label: "Off" },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ];
    const options = buildThinkingOptions(levels, "");
    expect(options.map((o) => o.value)).toEqual(["low", "high"]);
  });

  it("strips off entries regardless of casing or surrounding whitespace", () => {
    const levels: GatewayThinkingLevelOption[] = [
      { id: " OFF ", label: "Off" },
      { id: "none", label: "None" },
      { id: "medium", label: "Medium" },
    ];
    const options = buildThinkingOptions(levels, "");
    expect(options.map((o) => o.value)).toEqual(["medium"]);
  });

  it("does not include the current override when it normalizes to off", () => {
    const levels: GatewayThinkingLevelOption[] = [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ];
    const options = buildThinkingOptions(levels, "off");
    expect(options.map((o) => o.value)).toEqual(["low", "high"]);
  });

  it("keeps non-off levels and a non-off current override", () => {
    const levels: GatewayThinkingLevelOption[] = [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ];
    const options = buildThinkingOptions(levels, "custom");
    expect(options.map((o) => o.value)).toEqual(["low", "high", "custom"]);
  });

  it("returns an empty list when the model only exposes off", () => {
    const levels: GatewayThinkingLevelOption[] = [{ id: "off", label: "Off" }];
    const options = buildThinkingOptions(levels, "");
    expect(options).toEqual([]);
  });
});
