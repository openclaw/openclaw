import { describe, expect, it } from "vitest";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { validateOpenClawPackageInstallCompatibility } from "./package-compat.js";

describe("plugin package install compatibility", () => {
  it("accepts independent package compatibility floors without requiring package-host equality", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      currentHostVersion: "2026.5.21",
      pluginId: "example-plugin",
      packageMetadata: {
        install: { minHostVersion: ">=2026.5.1-beta.1" },
        compat: { pluginApi: ">=2026.5.19" },
      },
    });

    expect(result).toBeNull();
  });

  it("rejects a package whose minimum host floor exceeds the current host", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      currentHostVersion: "2026.5.21",
      pluginId: "example-plugin",
      packageMetadata: { install: { minHostVersion: ">=2026.5.22" } },
    });

    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
    });
    expect(result?.error).toContain("requires OpenClaw >=2026.5.22");
  });

  it("rejects a package whose plugin API range excludes the current runtime", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      currentHostVersion: "2026.5.21",
      pluginId: "example-plugin",
      packageMetadata: { compat: { pluginApi: ">=2026.5.22" } },
    });

    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API,
    });
    expect(result?.error).toContain("requires plugin API >=2026.5.22");
  });

  it("reports an unknown host before checking the plugin API", () => {
    const result = validateOpenClawPackageInstallCompatibility({
      currentHostVersion: "unknown",
      pluginId: "example-plugin",
      packageMetadata: {
        install: { minHostVersion: ">=2026.5.1" },
        compat: { pluginApi: ">=2026.5.22" },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: PLUGIN_INSTALL_ERROR_CODE.UNKNOWN_HOST_VERSION,
    });
  });

  it.each([
    {
      packageMetadata: {
        install: { minHostVersion: "2026.5.22" },
        compat: { pluginApi: 20260522 },
      },
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_MIN_HOST_VERSION,
    },
    {
      packageMetadata: { compat: { pluginApi: 20260522 } },
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_PLUGIN_API,
    },
  ])("rejects malformed compatibility metadata with $code", ({ packageMetadata, code }) => {
    const result = validateOpenClawPackageInstallCompatibility({
      currentHostVersion: "2026.5.21",
      pluginId: "example-plugin",
      packageMetadata,
    });

    expect(result).toMatchObject({ ok: false, code });
  });
});
