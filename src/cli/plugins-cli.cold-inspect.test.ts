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

it.each([false, true])(
  "registered plugins list/info/inspect retain cold CLI capabilities when enabled=%s",
  async (enabled) => {
    const fixture = createFixture(enabled);
    const plugin = {
      id: pluginId,
      enabled,
      status: enabled ? "loaded" : "disabled",
      cliBackendIds,
    };
    expect(await runPluginsCommand(["list"])).toMatchObject({
      plugins: [expect.objectContaining(plugin)],
    });
    for (const command of ["info", "inspect"]) {
      const inspected = await runPluginsCommand([command, pluginId]);
      expect(inspected).toMatchObject({
        plugin: { ...plugin, imported: false },
        capabilities: [{ kind: "cli-backend", ids: cliBackendIds }],
      });
      expect(inspected).not.toHaveProperty("inspectionScope");
    }
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  },
);

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
      inspectionScope: "cli",
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(enabled);
  },
);

it("registered plugins inspect --all reports the selected duplicate without importing either entry", async () => {
  const selected = createFixture(true);
  const duplicateRoot = path.join(path.dirname(selected.rootDir), "state", "extensions", pluginId);
  fs.mkdirSync(duplicateRoot, { recursive: true });
  const duplicate = createColdPluginFixture({
    rootDir: duplicateRoot,
    pluginId,
    manifest: { cliBackends: ["overridden-cli"] },
  });
  expect(await runPluginsCommand(["inspect", "--all"])).toMatchObject([
    {
      plugin: {
        id: pluginId,
        source: fs.realpathSync(selected.runtimeSource),
        enabled: true,
        status: "loaded",
        imported: false,
        cliBackendIds,
      },
    },
  ]);
  expect(isColdPluginRuntimeLoaded(selected)).toBe(false);
  expect(isColdPluginRuntimeLoaded(duplicate)).toBe(false);
});

it("registered plugins inspect --runtime reports registrations rather than unregistered declarations", async () => {
  const fixture = createFixture(true);
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { register(api) {
      api.registerCliBackend({ id: "runtime-cli", config: { command: "fixture-cli" } });
    } };`,
  );
  expect(await runPluginsCommand(["inspect", pluginId, "--runtime"])).toMatchObject({
    plugin: {
      id: pluginId,
      enabled: true,
      status: "loaded",
      imported: true,
      cliBackendIds: ["runtime-cli"],
    },
    capabilities: [{ kind: "cli-backend", ids: ["runtime-cli"] }],
    inspectionScope: "cli",
  });
});
