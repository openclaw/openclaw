import { beforeEach, describe, expect, it, vi } from "vitest";
import { preflightConfiguredNpmPluginTargets } from "./update-command-plugin-preflight.js";

const mocks = vi.hoisted(() => ({
  targets: vi.fn(),
  metadata: vi.fn(),
  installs: vi.fn(),
  manifest: vi.fn(),
}));
vi.mock("../../commands/doctor/shared/missing-configured-plugin-install.targets.js", () => ({
  collectConfiguredNpmPluginTargets: mocks.targets,
}));
vi.mock("../../infra/install-source-utils.js", () => ({
  resolveNpmSpecMetadata: mocks.metadata,
}));
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.installs,
}));
vi.mock("../../infra/package-update-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/package-update-utils.js")>()),
  readInstalledPackageManifest: mocks.manifest,
}));

const params = {
  config: {},
  env: {},
  targetVersion: "2026.9.4",
  channel: "stable" as const,
  timeoutMs: 1000,
};

describe("core update plugin availability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.targets.mockResolvedValue([
      { pluginId: "first", spec: "@example/first" },
      { pluginId: "second", spec: "@example/second" },
    ]);
    mocks.installs.mockResolvedValue({
      first: { source: "npm", spec: "@example/first", installPath: "/plugins/first" },
      second: { source: "npm", spec: "@example/second", installPath: "/plugins/second" },
    });
    mocks.manifest.mockReturnValue({
      version: "1.0.0",
      openclaw: { compat: { pluginApi: "<2026.9.4" } },
    });
  });

  it("reports a failed plugin and continues checking the remaining targets", async () => {
    mocks.metadata
      .mockResolvedValueOnce({ ok: false, error: "Registry unavailable" })
      .mockResolvedValueOnce({ ok: true, metadata: { name: "@example/second", version: "1.0.0" } });

    const warnings = await preflightConfiguredNpmPluginTargets(params);

    expect(warnings).toEqual([
      {
        pluginId: "first",
        reason:
          "Installed 1.0.0 requires plugin API <2026.9.4; @example/first: Registry unavailable",
        message:
          'Plugin "first" update availability could not be confirmed; the core update can continue.',
        guidance: [],
      },
    ]);
    expect(mocks.metadata).toHaveBeenCalledTimes(2);
    expect(mocks.metadata).toHaveBeenLastCalledWith({ spec: "@example/second", timeoutMs: 1000 });
  });

  it.each(["discovery", "metadata"])("preserves an unclassified %s failure", async (stage) => {
    const failure = new Error("State ownership changed");
    mocks[stage === "discovery" ? "targets" : "metadata"].mockRejectedValueOnce(failure);

    await expect(preflightConfiguredNpmPluginTargets(params)).rejects.toBe(failure);
    expect(mocks.metadata).toHaveBeenCalledTimes(stage === "discovery" ? 0 : 1);
  });
});
