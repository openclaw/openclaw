import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { filterRecordsToActive } from "./active-payload-verification.js";

function filter(
  records: Record<string, PluginInstallRecord>,
  plugins: OpenClawConfig["plugins"] = { enabled: true },
  env?: NodeJS.ProcessEnv,
) {
  return filterRecordsToActive({ records, cfg: { plugins }, env });
}

describe("filterRecordsToActive", () => {
  it.each(["__proto__", "constructor", "toString"] as const)(
    "retains active %s records as own enumerable entries without cloning",
    (pluginId) => {
      const record: PluginInstallRecord = { source: "npm", installPath: `/p/${pluginId}` };
      const records = Object.create(null) as Record<string, PluginInstallRecord>;
      Object.defineProperty(records, pluginId, {
        configurable: true,
        enumerable: true,
        value: record,
        writable: true,
      });

      const filtered = filter(records);

      expect(Object.getPrototypeOf(filtered)).toBeNull();
      expect(Object.keys(filtered)).toEqual([pluginId]);
      expect(Object.getOwnPropertyDescriptor(filtered, pluginId)).toMatchObject({
        enumerable: true,
        value: record,
      });
      expect(filtered[pluginId]).toBe(record);
    },
  );

  it("drops records for plugins whose entry is explicitly disabled", () => {
    const records = {
      "stale-disabled": { source: "npm" as const, installPath: "/p/stale" },
      "active-plugin": { source: "npm" as const, installPath: "/p/active" },
    };
    const filtered = filter(records, {
      enabled: true,
      entries: { "stale-disabled": { enabled: false }, "active-plugin": { enabled: true } },
    });
    expect(filtered).toEqual({
      "active-plugin": { source: "npm", installPath: "/p/active" },
    });
  });

  it("drops records for plugins listed in plugins.deny", () => {
    const records = {
      denied: { source: "npm" as const, installPath: "/p/denied" },
    };
    const filtered = filter(records, { enabled: true, deny: ["denied"] });
    expect(filtered).toEqual({});
  });

  it("retains a disabled trusted-source-linked official npm install (mirroring syncOfficialPluginInstalls policy)", () => {
    // Trusted official installs stay authoritative even when disabled.
    const records = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex",
        installPath: "/p/codex",
        trustedSourceLinkedOfficial: true,
      },
    };
    const filtered = filter(
      records,
      { enabled: true, entries: { codex: { enabled: false } } },
      { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    );
    expect(filtered).toEqual(records);
  });
});
