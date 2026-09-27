import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveToolSearchConfig,
  setToolSearchCodeModeSupportedForTest,
} from "./tool-search-config.js";

describe("Tool Search activation defaults", () => {
  afterEach(() => setToolSearchCodeModeSupportedForTest(undefined));

  it("uses structured search without authored settings", () => {
    expect(resolveToolSearchConfig()).toMatchObject({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 8,
      maxSearchLimit: 20,
    });
  });

  it.each([
    { raw: false, enabled: false, mode: "code" },
    { raw: true, enabled: true, mode: "code" },
    { raw: {}, enabled: false, mode: "code" },
    { raw: { mode: "tools" }, enabled: true, mode: "tools" },
    { raw: { mode: "directory" }, enabled: true, mode: "directory" },
    { raw: { mode: "code" }, enabled: true, mode: "code" },
    { raw: { enabled: false, mode: "tools" }, enabled: false, mode: "tools" },
  ] satisfies Array<{
    raw: NonNullable<NonNullable<OpenClawConfig["tools"]>["toolSearch"]>;
    enabled: boolean;
    mode: string;
  }>)("preserves authored $raw configuration", ({ raw, enabled, mode }) => {
    setToolSearchCodeModeSupportedForTest(true);
    expect(resolveToolSearchConfig({ tools: { toolSearch: raw } })).toMatchObject({
      enabled,
      mode,
    });
  });
});
