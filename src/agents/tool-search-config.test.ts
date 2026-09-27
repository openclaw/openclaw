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
    expect(resolveToolSearchConfig({ tools: { toolSearch: raw } })).toMatchObject({
      enabled,
      mode,
    });
  });

  it("honors code mode under Electron", () => {
    const electronDescriptor = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", {
      configurable: true,
      value: "99.0.0",
    });
    try {
      expect(resolveToolSearchConfig({ tools: { toolSearch: true } }).mode).toBe("code");
    } finally {
      if (electronDescriptor) {
        Object.defineProperty(process.versions, "electron", electronDescriptor);
      } else {
        delete (process.versions as NodeJS.ProcessVersions & { electron?: string }).electron;
      }
    }
  });
});
