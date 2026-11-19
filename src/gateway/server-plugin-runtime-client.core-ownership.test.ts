import { describe, expect, it, vi } from "vitest";

vi.mock("../plugins/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/runtime.js")>()),
  getActivePluginRegistry: () => ({
    plugins: [
      {
        id: "fixture",
        contracts: { tools: ["write", "exec", "sessions_create", "browser", "fixture_tool"] },
      },
    ],
    tools: ["write", "exec", "sessions_create", "browser", "fixture_tool"].map((name) => ({
      pluginId: "fixture",
      names: [name],
    })),
  }),
}));

import { resolvePluginSubagentToolsAlsoAllow } from "./server-plugin-runtime-client.js";

describe("plugin subagent core ownership", () => {
  it.each(["write", "exec", "sessions_create"])(
    "rejects a manifest claim on core-built %s",
    (name) => {
      expect(() =>
        resolvePluginSubagentToolsAlsoAllow({ pluginId: "fixture", toolsAlsoAllow: [name] }),
      ).toThrow(/may not add core tool/);
    },
  );
  it("retains genuinely plugin-built and plugin-specific grants", () => {
    expect(
      resolvePluginSubagentToolsAlsoAllow({
        pluginId: "fixture",
        toolsAlsoAllow: ["browser", "fixture_tool"],
      }),
    ).toEqual({ pluginId: "fixture", toolNames: ["browser", "fixture_tool"] });
  });
});
