import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import type { installPluginFromPath } from "../plugins/install.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  configWriteMock,
  installHooksFromPathMock,
  installPluginFromPathMock,
  pluginsCliRuntimeLogs,
  pluginLifecycleGatewayMock,
  resolvePluginLifecycleGatewayMock,
  recordHookInstallMock,
  resetPluginsCliTestState,
  runPluginsCommand,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

describe("plugin install warning output", () => {
  beforeEach(resetPluginsCliTestState);

  it.each(["success", "failure"])("delivers live warnings once through %s", async (outcome) => {
    await withTempDir("openclaw-warning-output-", async (rootDir) => {
      createColdPluginFixture({ rootDir, pluginId: "demo" });
      const warning = "Installer reported a non-blocking warning";
      const progress = "Preparing plugin files";
      const warningLines = () => pluginsCliRuntimeLogs.filter((line) => line.includes(warning));
      installPluginFromPathMock.mockImplementation(async (...args: unknown[]) => {
        const params = args[0] as Parameters<typeof installPluginFromPath>[0];
        params.logger?.info?.(progress);
        params.logger?.warn?.(warning);
        expect(warningLines()).toHaveLength(1);
        return outcome === "failure"
          ? { ok: false, error: "Artifact install failed" }
          : {
              ok: true,
              pluginId: "demo",
              targetDir: rootDir,
              version: "1.0.0",
              extensions: ["./index.cjs"],
            };
      });

      const install = runPluginsCommand([
        "plugins",
        "install",
        rootDir,
        "--link",
        "--force",
        "--accept-capabilities",
      ]);
      if (outcome === "failure") {
        await expect(install).rejects.toThrow("__exit__:1");
      } else {
        await install;
        expect(pluginsCliRuntimeLogs).toContain("Saved for the next Gateway start.");
      }
      expect(warningLines()).toHaveLength(1);
      expect(pluginsCliRuntimeLogs.filter((line) => line === progress)).toHaveLength(1);
    });
  });

  it("delivers warnings returned by the Gateway", async () => {
    const warning = "Installed plugin requires configuration";
    resolvePluginLifecycleGatewayMock.mockResolvedValue(pluginLifecycleGatewayMock);
    pluginLifecycleGatewayMock.mockResolvedValue({
      plugin: { id: "demo" },
      runtime: { operationId: "installed-demo", generation: 7, pluginIds: ["demo"] },
      warnings: [warning],
    });

    await runPluginsCommand([
      "plugins",
      "install",
      "npm:demo@1.0.0",
      "--force",
      "--accept-capabilities",
    ]);

    expect(pluginsCliRuntimeLogs.filter((line) => line.includes(warning))).toHaveLength(1);
    expect(pluginsCliRuntimeLogs).toContain("Applied in Gateway generation 7.");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
  });
});

describe.each(["plugin", "hook pack"] as const)("local %s install reports", (kind) => {
  beforeEach(resetPluginsCliTestState);

  it.each([
    ["Unicode", "café-🦀", "café-🦀"],
    ["terminal controls", "café\u001b[31m\nFORGED\trow\r🦀", "café\\nFORGED\\trow\\r🦀"],
  ])("renders %s without changing persisted identity", async (_case, id, displayed) => {
    await withTempDir("openclaw-install-report-", async (sourcePath) => {
      const targetDir = installedPluginRoot(resolveStateDir(), id);
      if (kind === "plugin") {
        createColdPluginFixture({ rootDir: sourcePath, pluginId: id });
        installPluginFromPathMock.mockResolvedValue({
          ok: true,
          pluginId: id,
          targetDir,
          version: "1.0.0",
        });
      } else {
        installHooksFromPathMock.mockResolvedValue({
          ok: true,
          hookPackId: id,
          hooks: [id],
          packageKind: "hook-only",
          targetDir,
        });
      }

      await runPluginsCommand([
        "plugins",
        "install",
        sourcePath,
        "--force",
        "--accept-capabilities",
      ]);

      if (kind === "plugin") {
        const records =
          writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock.mock.calls[0]?.[0];
        expect(records?.[id]).toMatchObject({
          sourcePath,
          installPath: targetDir,
        });
      } else {
        expect(recordHookInstallMock.mock.calls[0]?.[0]).toMatchObject({
          hookId: id,
          hooks: [id],
          sourcePath,
          installPath: targetDir,
        });
        expect(configWriteMock).toHaveBeenCalledWith({
          hooks: { internal: { enabled: true, entries: { [id]: { enabled: true } } } },
        });
      }
      expect(pluginsCliRuntimeLogs).toContain(`Installed ${kind}: ${displayed}`);
    });
  });
});
