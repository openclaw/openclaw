import { describe, expect, it, vi } from "vitest";
import * as index from "./installed-plugin-index-records.js";
import {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "./plugin-install-preflight.js";

describe("preflightPluginInstall", () => {
  it("reuses an exact installed version", async () => {
    using _ = vi.spyOn(index, "loadInstalledPluginIndexInstallRecords").mockResolvedValue({
      audit: {
        source: "clawhub",
        clawhubPackage: "@acme/audit",
        resolvedVersion: "1.2.3",
        installedAt: "2026-07-17T00:00:00.000Z",
      },
    });
    const result = await preflightPluginInstall({
      clawhubPackage: "@acme/audit",
      expectedVersion: "1.2.3",
    });
    expect(result).toMatchObject({
      ok: true,
      action: "reuse",
      installedAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("rejects a different installed version", async () => {
    using _ = vi.spyOn(index, "loadInstalledPluginIndexInstallRecords").mockResolvedValue({
      audit: { source: "clawhub", clawhubPackage: "@acme/audit", resolvedVersion: "1.1.0" },
    });
    const result = await preflightPluginInstall({
      clawhubPackage: "@acme/audit",
      expectedVersion: "1.2.3",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "plugin_version_conflict",
      installedVersion: "1.1.0",
    });
  });
});

describe("resolveInstalledClawHubPlugin", () => {
  it("returns the runtime plugin id for one ClawHub package", async () => {
    using _ = vi.spyOn(index, "loadInstalledPluginIndexInstallRecords").mockResolvedValue({
      "audit-runtime": {
        source: "clawhub",
        clawhubPackage: "@acme/audit",
        resolvedVersion: "1.2.3",
      },
    });
    await expect(
      resolveInstalledClawHubPlugin({ clawhubPackage: "@acme/audit" }),
    ).resolves.toMatchObject({
      status: "found",
      pluginId: "audit-runtime",
      installedVersion: "1.2.3",
    });
  });

  it("reports ambiguous package identities instead of choosing one", async () => {
    using _ = vi.spyOn(index, "loadInstalledPluginIndexInstallRecords").mockResolvedValue({
      first: { source: "clawhub", clawhubPackage: "audit", version: "1.0.0" },
      second: { source: "clawhub", clawhubPackage: "audit", version: "1.0.0" },
    });
    await expect(resolveInstalledClawHubPlugin({ clawhubPackage: "audit" })).resolves.toEqual({
      status: "ambiguous",
      pluginIds: ["first", "second"],
    });
  });
});
