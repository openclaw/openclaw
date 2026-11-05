import { describe, expect, it } from "vitest";
import {
  bindAgentToolReplaySafety,
  collectReplaySafeToolNames,
  collectSideEffectToolOwners,
  isAgentToolReplaySafe as replaySafe,
} from "./tool-replay-safety.js";

const declared = (value: boolean) => ({ declaredReplaySafe: () => value });

describe("agent tool replay safety", () => {
  it.each([
    ["search", undefined, true],
    ["progress_card", undefined, false],
    ["process", undefined, false],
    ["vendor_widget", undefined, false],
    ["search", false, false],
    ["x_search", true, true],
    ["vendor_widget", true, false],
    ["vendor_widget", false, false],
    ["memory_search", true, false],
  ] as const)("classifies %s with owner declaration %s", (name, declaration, replay) => {
    const options = declaration === undefined ? undefined : declared(declaration);
    expect(replaySafe({ name }, options)).toBe(replay);
  });

  it("binds read-only recovery safety to the concrete variant rather than its historical name", () => {
    const reader = bindAgentToolReplaySafety({ name: "automations" }, "bounded-read");
    const ordinaryTool = { name: "automations" };

    expect(replaySafe(reader)).toBe(true);
    expect(replaySafe(ordinaryTool)).toBe(false);
    expect(replaySafe({ ...reader })).toBe(false);
    expect(replaySafe(reader, declared(false))).toBe(false);
    expect(collectReplaySafeToolNames([reader, ordinaryTool])).toEqual(new Set());
  });

  it("rejects duplicate names from name-only replay metadata", () => {
    const coreTool = { name: "search" };
    const pluginTool = { name: "search" };

    expect(
      collectReplaySafeToolNames([coreTool, pluginTool], {
        declaredReplaySafe: (tool) => (tool === pluginTool ? true : undefined),
      }),
    ).toEqual(new Set());
  });

  it("retains canonical owners only for unique side-effecting tool names", () => {
    const memoryStore = { name: "memory_store" };
    const unrelatedStore = { name: "vendor_store" };
    const shadowedStore = { name: "memory_store" };
    const options = {
      declaredOwner: (tool: { name?: string }) =>
        tool === memoryStore ? '["memory-lancedb","memory_store"]' : undefined,
    };
    expect(
      collectSideEffectToolOwners([memoryStore, unrelatedStore, shadowedStore], options),
    ).toEqual(new Map());
    expect(collectSideEffectToolOwners([memoryStore, unrelatedStore], options)).toEqual(
      new Map([["memory_store", '["memory-lancedb","memory_store"]']]),
    );
  });
});
