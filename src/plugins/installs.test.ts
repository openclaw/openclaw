import { describe, expect, it } from "vitest";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";

describe("buildNpmResolutionInstallFields", () => {
  it("maps npm resolution metadata into install record fields", () => {
    const fields = buildNpmResolutionInstallFields({
      name: "@openclaw/demo",
      version: "1.2.3",
      resolvedSpec: "@openclaw/demo@1.2.3",
      integrity: "sha512-abc",
      shasum: "deadbeef",
      resolvedAt: "2026-02-22T00:00:00.000Z",
    });
    expect(fields).toEqual({
      resolvedName: "@openclaw/demo",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@openclaw/demo@1.2.3",
      integrity: "sha512-abc",
      shasum: "deadbeef",
      resolvedAt: "2026-02-22T00:00:00.000Z",
    });
  });

  it("returns undefined fields when resolution is missing", () => {
    expect(buildNpmResolutionInstallFields(undefined)).toEqual({
      resolvedName: undefined,
      resolvedVersion: undefined,
      resolvedSpec: undefined,
      integrity: undefined,
      shasum: undefined,
      resolvedAt: undefined,
    });
  });
});

describe("recordPluginInstall", () => {
  it("stores install metadata for the plugin id", () => {
    const next = recordPluginInstall({}, { pluginId: "demo", source: "npm", spec: "demo@latest" });
    expect(next.plugins?.installs?.demo).toMatchObject({
      source: "npm",
      spec: "demo@latest",
    });
    expect(typeof next.plugins?.installs?.demo?.installedAt).toBe("string");
  });
});
