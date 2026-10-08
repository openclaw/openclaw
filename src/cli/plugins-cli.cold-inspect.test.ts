import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { defaultRuntime } from "../runtime.js";
import { registerPluginsCli } from "./plugins-cli.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginId = "inspect-cli-proof";
const cliBackendIds = ["proof-cli", "proof-setup-cli"];

afterEach(() => {
  resetConfigRuntimeState();
  clearPluginMetadataLifecycleCaches();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createFixture(enabled: boolean) {
  const root = tempDirs.make("openclaw-cli-cold-inspect-");
  const pluginRoot = path.join(root, "plugin");
  const bundledRoot = path.join(root, "bundled");
  fs.mkdirSync(pluginRoot);
  fs.mkdirSync(bundledRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId,
    manifest: {
      providers: [],
      channels: [],
      cliBackends: ["proof-cli"],
      setup: { cliBackends: ["proof-setup-cli"] },
    },
  });
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled } },
      },
    }),
  );
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
  resetConfigRuntimeState();
  return fixture;
}

async function runPluginsCommand(args: string[]): Promise<unknown> {
  let output = "";
  vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((text) => {
    output += text;
  });
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    output = JSON.stringify(value);
  });
  const program = new Command();
  registerPluginsCli(program);
  await program.parseAsync(["node", "openclaw", "plugins", ...args, "--json"]);
  return JSON.parse(output);
}

it("registered plugins list/info/inspect retain disabled cold CLI capabilities", async () => {
  const fixture = createFixture(false);
  const plugin = {
    id: pluginId,
    enabled: false,
    status: "disabled",
    cliBackendIds,
  };
  expect(await runPluginsCommand(["list"])).toMatchObject({
    plugins: [expect.objectContaining(plugin)],
  });
  for (const command of ["info", "inspect"]) {
    expect(await runPluginsCommand([command, pluginId])).toMatchObject({
      plugin: { ...plugin, imported: false },
      capabilities: [{ kind: "cli-backend", ids: cliBackendIds }],
    });
  }
  expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
});

it.each([false, true])(
  "registered plugins inspect --runtime preserves activation and executable capabilities when enabled=%s",
  async (enabled) => {
    const fixture = createFixture(enabled);
    expect(await runPluginsCommand(["inspect", pluginId, "--runtime"])).toMatchObject({
      plugin: {
        id: pluginId,
        enabled,
        status: enabled ? "error" : "disabled",
        imported: enabled,
        cliBackendIds: [],
      },
      capabilities: [],
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(enabled);
  },
);
