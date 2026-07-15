import { describe, expect, it, vi } from "vitest";
import { preflightPluginInstall } from "./plugin-install-preflight.js";

describe("preflightPluginInstall", () => {
  it("reuses an exact installed version", async () => {
    const result = await preflightPluginInstall({
      clawhubPackage: "@acme/audit",
      rawSpec: "clawhub:@acme/audit@1.2.3",
      expectedVersion: "1.2.3",
      loadInstallRecords: vi.fn().mockResolvedValue({
        audit: { source: "clawhub", clawhubPackage: "@acme/audit", resolvedVersion: "1.2.3" },
      }),
    });
    expect(result).toMatchObject({ ok: true, action: "reuse", installedVersion: "1.2.3" });
  });

  it("rejects a different installed version", async () => {
    const result = await preflightPluginInstall({
      clawhubPackage: "@acme/audit",
      rawSpec: "clawhub:@acme/audit@1.2.3",
      expectedVersion: "1.2.3",
      loadInstallRecords: vi.fn().mockResolvedValue({
        audit: { source: "clawhub", clawhubPackage: "@acme/audit", resolvedVersion: "1.1.0" },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "plugin_version_conflict",
      installedVersion: "1.1.0",
    });
  });
});
