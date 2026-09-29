import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { filterRecordsToActive } from "./active-payload-verification.js";

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

      const filtered = filterRecordsToActive({
        cfg: { plugins: { enabled: true } } as unknown as OpenClawConfig,
        records,
      });

      expect(Object.getPrototypeOf(filtered)).toBeNull();
      expect(Object.keys(filtered)).toEqual([pluginId]);
      expect(Object.hasOwn(filtered, pluginId)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(filtered, pluginId)).toMatchObject({
        enumerable: true,
        value: record,
      });
      expect(filtered[pluginId]).toBe(record);
    },
  );

  it("retains records for plugins whose entry is enabled", () => {
    const records = {
      enabled: { source: "npm" as const, installPath: "/p/enabled" },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: { enabled: true, entries: { enabled: { enabled: true } } },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual(records);
  });

  it("drops records for plugins whose entry is explicitly disabled", () => {
    const records = {
      "stale-disabled": { source: "npm" as const, installPath: "/p/stale" },
      "active-plugin": { source: "npm" as const, installPath: "/p/active" },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: {
          enabled: true,
          entries: {
            "stale-disabled": { enabled: false },
            "active-plugin": { enabled: true },
          },
        },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual({
      "active-plugin": { source: "npm", installPath: "/p/active" },
    });
  });

  it("drops records for plugins listed in plugins.deny", () => {
    const records = {
      denied: { source: "npm" as const, installPath: "/p/denied" },
    };
    const filtered = filterRecordsToActive({
      cfg: {
        plugins: {
          enabled: true,
          deny: ["denied"],
        },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual({});
  });

  it("retains a disabled trusted-source-linked official npm install (mirroring syncOfficialPluginInstalls policy)", () => {
    // The Codex install record carries the trusted-source marker. The
    // existing post-update sync path treats it as authoritative regardless
    // of the entry's enable flag, so the convergence smoke check must too.
    const records = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex",
        installPath: "/p/codex",
        trustedSourceLinkedOfficial: true,
      },
    };
    const filtered = filterRecordsToActive({
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      cfg: {
        plugins: {
          enabled: true,
          entries: { codex: { enabled: false } },
        },
      } as unknown as OpenClawConfig,
      records,
    });
    expect(filtered).toEqual(records);
  });
});
