import { describe, expect, it } from "vitest";
import {
  bindAgentToolReplaySafety,
  collectReplaySafeToolNames,
  collectSideEffectToolOwners,
  isAgentToolReplaySafe,
  isAgentToolRestartSafe,
} from "./tool-replay-safety.js";
import { TOOL_CALL_RAW_TOOL_NAME } from "./tool-search-types.js";

const declared = (value: boolean) => ({ declaredReplaySafe: () => value });

describe("agent tool replay safety", () => {
  it("allows only audited unconditional core tools", () => {
    expect(isAgentToolReplaySafe({ name: "search" })).toBe(true);
    expect(isAgentToolReplaySafe({ name: "progress_card" })).toBe(false);
    expect(isAgentToolReplaySafe({ name: "process" })).toBe(false);
    expect(isAgentToolReplaySafe({ name: "vendor_widget" })).toBe(false);
  });

  it("requires extension-owned tools to opt in even when they reuse an audited name", () => {
    const pluginTool = { name: "search" };
    expect(
      isAgentToolReplaySafe(pluginTool, {
        declaredReplaySafe: (tool) => (tool === pluginTool ? false : undefined),
      }),
    ).toBe(false);
  });

  it("accepts opted-in extension tools only for audited names", () => {
    const xSearch = { name: "x_search" };
    const vendorWidget = { name: "vendor_widget" };
    const declaredReplaySafe = () => true;

    expect(isAgentToolReplaySafe(xSearch, { declaredReplaySafe })).toBe(true);
    expect(isAgentToolReplaySafe(vendorWidget, { declaredReplaySafe })).toBe(false);
  });

  it("accepts owner-declared concrete tools for restart-safe turns", () => {
    const pluginTool = { name: "vendor_widget" };

    expect(
      isAgentToolRestartSafe(pluginTool, {
        declaredReplaySafe: (tool) => (tool === pluginTool ? true : undefined),
      }),
    ).toBe(true);
    expect(isAgentToolRestartSafe(pluginTool, declared(false))).toBe(false);
  });

  it("admits only the concrete Tool Search dispatcher for explicit restart recovery", () => {
    const dispatcher = bindAgentToolReplaySafety({ name: TOOL_CALL_RAW_TOOL_NAME }, "dispatcher");

    expect(isAgentToolRestartSafe(dispatcher)).toBe(true);
    expect(isAgentToolReplaySafe(dispatcher)).toBe(false);
    expect(isAgentToolRestartSafe({ name: TOOL_CALL_RAW_TOOL_NAME })).toBe(false);
    expect(isAgentToolRestartSafe({ ...dispatcher })).toBe(false);
    for (const name of ["exec", "wait", "tool_call", "other_dispatcher"]) {
      expect(isAgentToolRestartSafe(bindAgentToolReplaySafety({ name }, "dispatcher")), name).toBe(
        false,
      );
    }
    expect(isAgentToolRestartSafe(dispatcher, declared(false))).toBe(false);
  });

  it("binds read-only recovery safety to the concrete variant rather than its historical name", () => {
    const reader = bindAgentToolReplaySafety({ name: "automations" }, "bounded-read");
    const ordinaryTool = { name: "automations" };

    expect(isAgentToolReplaySafe(reader)).toBe(true);
    expect(isAgentToolReplaySafe(ordinaryTool)).toBe(false);
    expect(isAgentToolReplaySafe({ ...reader })).toBe(false);
    expect(isAgentToolReplaySafe(reader, declared(false))).toBe(false);
    expect(collectReplaySafeToolNames([reader, ordinaryTool])).toEqual(new Set());
  });

  it("rejects memory_search because it records durable recall signals", () => {
    expect(isAgentToolReplaySafe({ name: "memory_search" }, declared(true))).toBe(false);
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
