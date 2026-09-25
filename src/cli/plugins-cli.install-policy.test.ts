import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import type { findBundledPluginSource } from "../plugins/bundled-sources.js";
import {
  applyExclusiveSlotSelectionMock,
  configWriteMock,
  enablePluginInConfigMock,
  findBundledPluginSourceMock,
  installHooksFromNpmSpecMock,
  installPluginFromNpmSpecMock,
  pluginCliConfigMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  runtimeErrors,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));

describe("plugins cli install policy", () => {
  beforeEach(resetPluginsCliTestState);

  it.each([
    { source: "npm", raw: "npm:demo", enabled: true },
    { source: "npm", raw: "npm:demo", enabled: false },
    { source: "bundled", raw: "demo", enabled: true },
    { source: "bundled fallback", raw: "demo-package", enabled: false },
  ])(
    "preserves plugin policy when installing from $source with --no-enable and enabled=$enabled",
    async ({ source, raw, enabled }) => {
      const pluginId = "demo";
      const targetDir = installedPluginRoot(resolveStateDir(), pluginId);
      const config = {
        plugins: {
          allow: ["other"],
          deny: [pluginId],
          entries: { [pluginId]: { enabled } },
        },
      };
      pluginCliConfigMock.mockReturnValue(config);
      findBundledPluginSourceMock.mockImplementation((input) => {
        const { lookup } = input as Parameters<typeof findBundledPluginSource>[0];
        return source === "bundled" ||
          (source === "bundled fallback" &&
            (lookup.kind === "npmSpec" || lookup.value === pluginId))
          ? { pluginId, localPath: targetDir }
          : undefined;
      });
      installPluginFromNpmSpecMock.mockResolvedValue(
        source === "bundled fallback"
          ? { ok: false, error: "npm error E404 package not found", code: "npm_package_not_found" }
          : { ok: true, pluginId, targetDir, version: "1.2.3" },
      );

      await runPluginsCommand([
        "plugins",
        "install",
        raw,
        "--no-enable",
        "--force",
        "--accept-capabilities",
      ]);

      expect(configWriteMock).toHaveBeenLastCalledWith(config);
      expect(
        writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[0]?.[0],
      ).toMatchObject({ [pluginId]: { source: source === "npm" ? "npm" : "path" } });
      expect(enablePluginInConfigMock).not.toHaveBeenCalled();
      expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    },
  );

  it("rejects --no-enable for hook-only fallback before installing hooks", async () => {
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
    });
    await expect(
      runPluginsCommand([
        "plugins",
        "install",
        "npm:@acme/demo-hooks",
        "--no-enable",
        "--force",
        "--accept-capabilities",
      ]),
    ).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain("--no-enable is only supported for plugins");
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });
});
