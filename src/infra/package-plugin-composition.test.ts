import { describe, expect, it } from "vitest";
import { composePackagePlugins } from "./package-plugin-composition.js";

describe("selected plugin package composition", () => {
  it("preserves npm's all-dependencies bundle form when selecting plugins", () => {
    const result = composePackagePlugins(
      {
        name: "openclaw",
        version: "2026.10.6",
        dependencies: { "core-dependency": "1.0.0" },
        bundledDependencies: true,
      },
      [
        {
          id: "fixture",
          packageJson: {
            name: "fixture-plugin",
            version: "2026.10.6",
            dependencies: { "plugin-dependency": "2.0.0" },
          },
        },
      ],
    );
    expect(result.bundleDependencies).toEqual(["core-dependency", "plugin-dependency"]);
    expect(result.bundledDependencies).toBeUndefined();
  });

  it("retains plugin-owned patched dependency bundles with the core bundle", () => {
    const result = composePackagePlugins(
      {
        name: "openclaw",
        version: "2026.10.6",
        dependencies: { "chrome-devtools-mcp": "1.11.0" },
        bundleDependencies: ["chrome-devtools-mcp"],
      },
      [
        {
          id: "openai",
          packageJson: {
            name: "@openclaw/openai-provider",
            version: "2026.10.6",
            dependencies: { "@shinyoshiaki/binary-data": "0.6.1", werift: "0.25.0" },
            bundleDependencies: ["@shinyoshiaki/binary-data"],
          },
        },
        {
          id: "qa-lab",
          packageJson: {
            name: "@openclaw/qa-lab",
            version: "2026.10.6",
            dependencies: { "@openclaw/crabline": "0.1.30" },
            bundledDependencies: ["@openclaw/crabline"],
          },
        },
      ],
    );
    expect(result.bundleDependencies).toEqual([
      "@openclaw/crabline",
      "@shinyoshiaki/binary-data",
      "chrome-devtools-mcp",
    ]);
    expect(result.dependencies).toEqual({
      "chrome-devtools-mcp": "1.11.0",
      "@shinyoshiaki/binary-data": "0.6.1",
      werift: "0.25.0",
      "@openclaw/crabline": "0.1.30",
    });
  });
});
