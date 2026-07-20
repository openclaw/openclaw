import { describe, expect, it } from "vitest";
import { resolvePluginSurface } from "../../scripts/lib/plugin-inventory-doc.mjs";

describe("resolvePluginSurface", () => {
  it("keeps manifest identifiers as inline code while leaving labels visible", () => {
    expect(
      resolvePluginSurface({
        id: "example",
        channels: ["discord"],
        providers: ["openai"],
        contracts: {
          webSearchProviders: {},
          tools: {},
        },
        dashboard: {
          dataBindings: [{ id: "items.list" }],
          actionVerbs: [{ id: "refresh" }],
        },
        skills: ["example"],
      }),
    ).toBe(
      "channels: `discord`; providers: `openai`; contracts: `tools`, `webSearchProviders`; dashboard data bindings: `example.items.list`; dashboard action verbs: `example.refresh`; skills",
    );
  });

  it("retains the generic fallback", () => {
    expect(resolvePluginSurface({})).toBe("plugin");
  });
});
