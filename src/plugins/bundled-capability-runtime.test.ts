// Verifies bundled capability runtime registration from plugin metadata.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  buildVitestCapabilityShimAliasMap,
  captureBundledCapabilityTools,
} from "./bundled-capability-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

function createTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: undefined }),
  };
}

describe("buildVitestCapabilityShimAliasMap", () => {
  it("keeps scoped and unscoped capability shim aliases aligned", () => {
    const aliasMap = buildVitestCapabilityShimAliasMap();

    expect(aliasMap["openclaw/plugin-sdk/config-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/config-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/media-runtime"]).toBe(
      aliasMap["@openclaw/plugin-sdk/media-runtime"],
    );
    expect(aliasMap["openclaw/plugin-sdk/provider-onboard"]).toBe(
      aliasMap["@openclaw/plugin-sdk/provider-onboard"],
    );
    expect(aliasMap["openclaw/plugin-sdk/speech-core"]).toBe(
      aliasMap["@openclaw/plugin-sdk/speech-core"],
    );
  });
});

describe("captureBundledCapabilityTools", () => {
  it("skips malformed captured tool names while preserving healthy tools", () => {
    const registry = createEmptyPluginRegistry();
    const healthyTool = createTool("healthy_tool");
    const unreadableTool = createTool("unreadable_tool");
    Object.defineProperty(unreadableTool, "name", {
      get: () => {
        throw new Error("boom");
      },
    });
    const blankNameTool = createTool("   ");
    const nonStringNameTool = {
      ...createTool("wrong_type_tool"),
      name: 42,
    } as unknown as AnyAgentTool;

    const capturedNames = captureBundledCapabilityTools({
      registry,
      record: {
        id: "demo",
        name: "Demo",
        source: "extensions/demo/src/index.ts",
        rootDir: "extensions/demo",
      },
      tools: [unreadableTool, blankNameTool, nonStringNameTool, healthyTool],
      declaredToolNames: ["healthy_tool"],
    });

    expect(capturedNames).toEqual(["healthy_tool"]);
    expect(registry.tools).toHaveLength(1);
    expect(registry.tools[0]?.names).toEqual(["healthy_tool"]);
    expect(registry.tools[0]?.factory({})).toBe(healthyTool);
    expect(registry.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "plugin tool is malformed (demo): tool[0] missing readable name",
      "plugin tool is malformed (demo): tool[1] missing readable name",
      "plugin tool is malformed (demo): tool[2] missing readable name",
    ]);
  });
});
