import { beforeEach, describe, expect, it } from "vitest";
import type { installPluginFromPath } from "../plugins/install.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  installPluginFromPathMock,
  pluginsCliRuntimeLogs,
  pluginLifecycleGatewayMock,
  resolvePluginLifecycleGatewayMock,
  resetPluginsCliTestState,
  runPluginsCommand,
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
