import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";

describe("Tool Search activation defaults", () => {
  it.each([undefined, {}, { tools: {} }] satisfies Array<OpenClawConfig | undefined>)(
    "uses structured search without authored settings: %j",
    (config) => {
      expect(resolveToolSearchConfig(config)).toMatchObject({
        enabled: true,
        mode: "tools",
        searchDefaultLimit: 8,
        maxSearchLimit: 20,
      });
    },
  );

  it.each([
    { raw: false, enabled: false, mode: "tools" },
    { raw: true, enabled: true, mode: "tools" },
    { raw: {}, enabled: false, mode: "tools" },
    { raw: { enabled: true }, enabled: true, mode: "tools" },
    { raw: { searchDefaultLimit: 4 }, enabled: true, mode: "tools" },
    { raw: { mode: "tools" }, enabled: true, mode: "tools" },
    { raw: { mode: "directory" }, enabled: true, mode: "directory" },
    { raw: { enabled: false, mode: "tools" }, enabled: false, mode: "tools" },
  ] satisfies Array<{
    raw: NonNullable<NonNullable<OpenClawConfig["tools"]>["toolSearch"]>;
    enabled: boolean;
    mode: string;
  }>)("preserves authored $raw configuration", ({ raw, enabled, mode }) => {
    expect(resolveToolSearchConfig({ tools: { toolSearch: raw } })).toMatchObject({
      enabled,
      mode,
    });
  });
});
