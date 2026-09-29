import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isToolSearchExplicitlyEnabled, resolveToolSearchConfig } from "./tool-search-config.js";

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

describe("isToolSearchExplicitlyEnabled", () => {
  it.each([
    { config: undefined, expected: false },
    { config: {}, expected: false },
    { config: { tools: {} }, expected: false },
    { config: { tools: { toolSearch: false } }, expected: false },
    { config: { tools: { toolSearch: {} } }, expected: false },
    { config: { tools: { toolSearch: { enabled: false } } }, expected: false },
    { config: { tools: { toolSearch: true } }, expected: true },
    { config: { tools: { toolSearch: { enabled: true } } }, expected: true },
    { config: { tools: { toolSearch: { mode: "directory" } } }, expected: true },
  ] satisfies Array<{ config: OpenClawConfig | undefined; expected: boolean }>)(
    "treats only authored enabled settings as opt-in: %j",
    ({ config, expected }) => {
      expect(isToolSearchExplicitlyEnabled(config)).toBe(expected);
    },
  );
});
