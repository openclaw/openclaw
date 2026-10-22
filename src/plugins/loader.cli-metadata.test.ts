// Covers plugin loader CLI metadata without activating plugin runtimes.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { channelFixtureSource, writeFixtureJson } from "./loader-fixture-builders.test-support.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  inlineChannelPluginEntryFactorySource,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import type { OpenClawPluginCliRootCommandDescriptor } from "./types.js";

beforeEach(useNoBundledPlugins);
afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function pluginConfig(file: string, id: string) {
  return { plugins: { load: { paths: [file] }, allow: [id] } };
}

function cliBody(
  id: string,
  descriptors: OpenClawPluginCliRootCommandDescriptor[],
  commands?: string[],
) {
  return `module.exports = { id: ${JSON.stringify(id)}, register(api) {
    api.registerCli(() => {}, ${JSON.stringify({ descriptors, commands })});
  } };`;
}

it.each(["explicit", "auto", "denied", "disabled"] as const)(
  "preserves admission before parser registration (%s)",
  async (policy) => {
    const markers = makePluginLoaderTempDir();
    const targetId = "Admission-Fixture";
    const command = "admission-fixture";
    const imported = path.join(markers, "target-imported");
    const unrelatedImported = path.join(markers, "unrelated-imported");
    const invoked = path.join(markers, "invoked");
    const target = writePlugin({
      id: targetId,
      filename: "index.cjs",
      body: `const fs = require("node:fs");
  fs.writeFileSync(${JSON.stringify(imported)}, "imported");
  module.exports = { id: ${JSON.stringify(targetId)}, register(api) {
    api.registerCli(({ program }) => program.command("${command}").action(() => {
      fs.writeFileSync(${JSON.stringify(invoked)}, api.registrationMode);
    }), { commands: ["${command}"] });
  } };`,
    });
    const unrelated = writePlugin({
      id: "unrelated-fixture",
      filename: "index.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(unrelatedImported)}, "imported");
  module.exports = { id: "unrelated-fixture", register() {} };`,
    });
    const config = {
      plugins: {
        enabled: true,
        allow: [command, unrelated.id],
        deny: policy === "denied" ? [command] : [],
        load: { paths: [target.file, unrelated.file] },
        entries: { [command]: { enabled: policy !== "disabled" } },
      },
    };
    const options = {
      config,
      activate: false,
      cache: false,
      onlyPluginIds: [targetId],
      activationSourceConfig: policy === "auto" ? { plugins: { enabled: true } } : undefined,
      autoEnabledReasons:
        policy === "auto" ? { [targetId]: ["configured fixture", "selected fixture"] } : undefined,
    };
    const registry = await loadOpenClawPluginCliRegistry(options);
    const enabled = policy === "explicit" || policy === "auto";
    const reasons = {
      auto: "configured fixture; selected fixture",
      denied: "blocked by denylist",
      disabled: "disabled in config",
      explicit: "enabled in config",
    };
    expect(registry.plugins).toMatchObject([
      {
        id: targetId,
        enabled,
        activated: enabled,
        status: enabled ? "loaded" : "disabled",
        activationSource: enabled ? policy : "disabled",
        activationReason: reasons[policy],
      },
    ]);
    expect(fs.existsSync(imported)).toBe(enabled);
    expect(fs.existsSync(unrelatedImported)).toBe(false);
    expect(registry.cliRegistrars).toHaveLength(enabled ? 1 : 0);
    if (enabled) {
      const program = new Command();
      await registry.cliRegistrars[0]!.register({
        program,
        parentPath: [],
        config,
        workspaceDir: undefined,
        logger: { info() {}, warn() {}, error() {} },
      });
      await program.parseAsync([command], { from: "user" });
      expect(fs.readFileSync(invoked, "utf8")).toBe("cli-metadata");
    } else {
      expect(fs.existsSync(invoked)).toBe(false);
    }
  },
);

it("keeps an explicit empty CLI metadata registry authoritative", async () => {
  const plugin = writePlugin({
    id: "empty-scope",
    filename: "index.cjs",
    body: 'module.exports = { id: "empty-scope", register(api) { api.registerCli(() => {}, { commands: ["empty-scope"] }); } };',
  });
  const registry = await loadOpenClawPluginCliRegistry({
    config: pluginConfig(plugin.file, plugin.id),
    manifestRegistry: { plugins: [], diagnostics: [] },
    installRecords: {},
  });
  expect(registry).toMatchObject({ plugins: [], cliRegistrars: [] });
});

it("loads packaged CLI metadata beside the resolved dist entry without evaluating the heavy entry", async () => {
  const pluginDir = makePluginLoaderTempDir();
  const distDir = path.join(pluginDir, "dist");
  const heavyMarker = path.join(pluginDir, "heavy-loaded.txt");
  fs.mkdirSync(distDir);
  const plugin = writePlugin({
    id: "packaged-cli-metadata",
    dir: pluginDir,
    filename: "dist/index.js",
    body: `require("node:fs").writeFileSync(${JSON.stringify(heavyMarker)}, "loaded");
module.exports = { id: "packaged-cli-metadata", register() {} };`,
  });
  writeFixtureJson(pluginDir, "package.json", {
    name: "packaged-cli-metadata",
    openclaw: { extensions: ["./dist/index.js"] },
  });
  fs.writeFileSync(
    path.join(distDir, "cli-metadata.js"),
    cliBody(plugin.id, [
      { name: "packaged-light", description: "Light entry", hasSubcommands: false },
    ]),
  );

  const registry = await loadOpenClawPluginCliRegistry({
    config: pluginConfig(pluginDir, plugin.id),
  });

  expect(fs.existsSync(heavyMarker)).toBe(false);
  expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toContain("packaged-light");
});

it.each([false, true])("selects the channel CLI entry (forced runtime: %s)", async (full) => {
  const id = "cli-channel";
  const root = makePluginLoaderTempDir();
  const pluginDir = path.join(root, id);
  fs.mkdirSync(pluginDir);
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  const modeMarker = path.join(pluginDir, "registration-mode.txt");
  const setupMarker = path.join(pluginDir, "setup-loaded.txt");
  if (!full) {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = root;
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  }
  writePluginMetadata({
    dir: pluginDir,
    id,
    channels: [id],
    packageJson: {
      name: `@openclaw/${id}`,
      openclaw: {
        extensions: ["./index.cjs"],
        setupEntry: full ? "./setup-entry.cjs" : undefined,
      },
    },
  });
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded");
${inlineChannelPluginEntryFactorySource()}
module.exports = defineChannelPluginEntry({
  id: "cli-channel", name: "Fixture", description: "fixture channel",
  plugin: ${channelFixtureSource(id)},
  registerCliMetadata(api) {
    require("node:fs").writeFileSync(${JSON.stringify(modeMarker)}, String(api.registrationMode), "utf-8");
    api.registerCli(() => {}, {
      descriptors: [{ name: "cli-channel", description: "Fixture command", hasSubcommands: true }],
    });
  },
});`,
    "utf-8",
  );
  if (full) {
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded", "utf-8");`,
      "utf-8",
    );
  }

  const config = {
    plugins: {
      ...(full ? { load: { paths: [pluginDir] } } : {}),
      allow: [id],
      entries: { [id]: { enabled: true } },
    },
  };
  const registry = full
    ? loadOpenClawPlugins({
        config,
        activate: false,
        cache: false,
        channelPluginLoadIntent: "full",
      })
    : await loadOpenClawPluginCliRegistry({ config });
  expect(fs.existsSync(fullMarker)).toBe(full);
  expect(fs.existsSync(setupMarker)).toBe(false);
  expect(registry.plugins.find((entry) => entry.id === id)?.status).toBe("loaded");
  expect(registry.cliRegistrars.flatMap((entry) => entry.commands).includes(id)).toBe(full);
  if (full) {
    expect(fs.readFileSync(modeMarker, "utf-8")).toBe("discovery");
  } else {
    expect(fs.existsSync(modeMarker)).toBe(false);
  }
});

it("sanitizes plugin CLI descriptor descriptions and rejects unsafe command names", async () => {
  const unsafeDescription =
    "Open \u001B]8;;https://example.test\u0007link\u001B]8;;\u0007 now\u001B[2J";
  const plugin = writePlugin({
    id: "unsafe-cli-descriptors",
    filename: "unsafe-cli-descriptors.cjs",
    body: cliBody(
      "unsafe-cli-descriptors",
      [
        { name: "safe-command", description: unsafeDescription, hasSubcommands: false },
        { name: "bad\nname", description: "Bad descriptor", hasSubcommands: false },
      ],
      ["bad\ncommand"],
    ),
  });

  const registry = await loadOpenClawPluginCliRegistry({
    cache: false,
    config: pluginConfig(plugin.dir, plugin.id),
  });

  expect(registry.cliRegistrars).toHaveLength(1);
  expect(registry.cliRegistrars[0]?.commands).toEqual(["safe-command"]);
  expect(registry.cliRegistrars[0]?.descriptors).toEqual([
    { name: "safe-command", description: "Open link now", hasSubcommands: false },
  ]);
  expect(registry.diagnostics.map((diag) => diag.message)).toEqual([
    'invalid cli descriptor name: "bad\\nname"',
    'invalid cli command name: "bad\\ncommand"',
  ]);
});

it("preserves root machine-output resolvers in metadata and full plugin loads", async () => {
  const plugin = writePlugin({
    id: "machine-output-cli",
    filename: "machine-output-cli.cjs",
    registration: `api.registerCli(() => {}, {
        commands: [" machine-output-cli ", "machine-output-cli", "additional-cli"],
        descriptors: [{
          name: "machine-output-cli",
          description: "Machine output CLI",
          hasSubcommands: true,
          machineOutput: ({ argv, stdoutIsTTY }) => argv.includes("--machine") || !stdoutIsTTY,
        }],
      });
      api.registerCli(() => {}, {
        parentPath: ["nodes"],
        commands: ["nested-machine-output", " nested-machine-output "],
        descriptors: [{
          name: "nested-machine-output",
          description: "Nested metadata",
          hasSubcommands: false,
          machineOutput: () => true,
        }],
      });`,
  });
  const config = pluginConfig(plugin.file, plugin.id);

  const metadataRegistry = await loadOpenClawPluginCliRegistry({ cache: false, config });
  const fullRegistry = loadOpenClawPlugins({ cache: false, config });
  for (const registry of [metadataRegistry, fullRegistry]) {
    expect(registry.cliRegistrars[0]?.commands).toEqual(["machine-output-cli", "additional-cli"]);
    expect(
      registry.plugins.find((entry) => entry.id === "machine-output-cli")?.cliCommands,
    ).toEqual(["machine-output-cli", "additional-cli", "nodes nested-machine-output"]);
    const resolver = registry.cliRegistrars[0]?.descriptors[0]?.machineOutput;
    const argv = ["node", "openclaw", "machine-output-cli"];
    expect(resolver?.({ argv, stdoutIsTTY: false })).toBe(true);
    expect(resolver?.({ argv: [...argv, "--machine"], stdoutIsTTY: true })).toBe(true);
    const nested = registry.cliRegistrars.find((entry) => entry.parentPath.length > 0);
    expect(nested?.commands).toEqual(["nested-machine-output"]);
    expect(nested?.descriptors[0]).not.toHaveProperty("machineOutput");
  }
});
