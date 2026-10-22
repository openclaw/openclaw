import fs from "node:fs";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { Command } from "commander";
import { afterAll, afterEach, expect, it, onTestFinished, vi } from "vitest";
import { registerNodesCli } from "../cli/nodes-cli/register.js";
import { CliPluginInvocationResources } from "../cli/plugin-invocation-resources.js";
import { configureProgramHelp } from "../cli/program/help.js";
import { isCommandJsonOutputMode } from "../cli/program/json-mode.js";
import { readBestEffortConfigSnapshot } from "../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import {
  cliEnv,
  createCliFixture,
  registerCli,
  writeJson,
  stringConfigSchema,
  pluginConfig,
  patchManifest,
} from "./cli-lifetime.test-support.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  loadPluginCliRegistrationEntriesWithDefaults,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { loadOpenClawPluginCliRegistry } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  useNoBundledPlugins,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { hasRetainedPluginRuntimeCloseError } from "./runtime-close-error.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";

async function withCommandFixture(
  run: (fixture: {
    program: Command;
    cfg: OpenClawConfig;
    configPath: string;
    loaded: string;
    registered: string;
  }) => Promise<void>,
  extraCommands: string[] = [],
) {
  const { root, configPath, env } = createCliFixture();
  const loaded = path.join(root, "loaded");
  const registered = path.join(root, "registered");
  const descriptors =
    '[{ name: "memory", description: "Memory commands", hasSubcommands: true, machineOutput: ({ argv }) => argv.includes("--machine") }]';
  const memory = writePlugin({
    id: "memory-cli",
    dir: path.join(root, "memory"),
    filename: "index.cjs",
    body: `require("node:fs").writeFileSync(${JSON.stringify(loaded)}, "loaded");
module.exports = { id: "memory-cli", register(api) {
  api.registerCli(({ program }) => {
    require("node:fs").writeFileSync(${JSON.stringify(registered)}, "registered");
    for (const name of ${JSON.stringify(["memory", ...extraCommands])}) program.command(name);
  }, { commands: ${JSON.stringify(["memory", ...extraCommands])}, descriptors: ${descriptors} });
} };`,
  });
  fs.writeFileSync(
    path.join(memory.dir, "cli-metadata.cjs"),
    `module.exports = { id: "memory-cli", register(api) { api.registerCli(() => {}, { commands: ["memory"], descriptors: ${descriptors} }); } };`,
  );
  const other = writePlugin({
    id: "other-cli",
    dir: path.join(root, "other"),
    filename: "index.cjs",
    registration:
      'api.registerCli(({ program }) => program.command("other"), { commands: ["other"] });',
  });
  const cfg: OpenClawConfig = {
    plugins: { allow: [memory.id, other.id], load: { paths: [memory.dir, other.dir] } },
  };
  writeJson(configPath, cfg);
  await withEnvAsync(env, () =>
    run({ program: new Command(), cfg, configPath, loaded, registered }),
  );
}

it("skips aliases without suppressing unrelated CLI registrations", () =>
  withCommandFixture(async ({ program, registered }) => {
    program.command("mem-core").alias("memory");
    await registerCli(program);
    expect(commandNames(program)).toEqual(["mem-core", "other"]);
    expect(fs.existsSync(registered)).toBe(false);
  }));

it.each([
  { mode: "eager" as const, primary: undefined },
  { mode: "lazy" as const, primary: "memory" },
  { mode: "lazy" as const, primary: undefined },
])("applies machine-output metadata in $mode registration", ({ mode, primary }) =>
  withCommandFixture(async ({ program }) => {
    await registerCli(program, { mode, primary });
    expect(
      isCommandJsonOutputMode(child(program, "memory"), [
        "node",
        "openclaw",
        "memory",
        "--machine",
      ]),
    ).toBe(true);
  }),
);

it("eagerly registers roots missing from lazy descriptors", () =>
  withCommandFixture(
    async ({ program, registered }) => {
      await registerCli(program, { mode: "lazy" });
      expect(commandNames(program)).toEqual(["memory", "memory-admin", "other"]);
      expect(fs.readFileSync(registered, "utf8")).toBe("registered");
    },
    ["memory-admin"],
  ));

it("does not import full runtime for an unowned primary", () =>
  withCommandFixture(async ({ program, loaded }) => {
    await registerCli(program, { mode: "lazy", primary: "missing-command" });
    expect(program.commands).toEqual([]);
    expect(fs.existsSync(loaded)).toBe(false);
  }));

it("preserves a pinned config instead of replacing it with the registration read", () =>
  withCommandFixture(async ({ program, loaded }) => {
    const active: OpenClawConfig = { plugins: { enabled: false } };
    setRuntimeConfigSnapshot(active, active);
    expect(await registerCli(program)).toBe(active);
    expect(fs.existsSync(loaded)).toBe(false);
  }));

it("rejects invalid core config before importing plugin runtime", () =>
  withCommandFixture(async ({ program, cfg, configPath, loaded }) => {
    writeJson(configPath, { ...cfg, gateway: { port: "invalid" } });
    await expect(registerCli(program)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      message: expect.stringContaining("gateway.port"),
    });
    expect(fs.existsSync(loaded)).toBe(false);
  }));

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});
afterAll(cleanupPluginLoaderFixturesForTest);

function child(program: Command, ...names: string[]): Command {
  return names.reduce(
    (parent, name) => parent.commands.find((command) => command.name() === name)!,
    program,
  );
}

const names = (entries: { name: string }[]) => entries.map((entry) => entry.name);
const commandNames = (program: Command) => program.commands.map((command) => command.name());
const requiredLabel = stringConfigSchema("label", { required: ["label"] });

async function nodesProgram(...args: string[]) {
  const program = new Command().exitOverride();
  configureProgramHelp(program, { programVersion: "fixture" });
  await registerNodesCli(program, ["node", "openclaw", "nodes", ...args]);
  return program;
}

async function configuredProgram(
  cfg: OpenClawConfig,
  env: ReturnType<typeof cliEnv>,
  options: NonNullable<Parameters<typeof registerCli>[1]>,
) {
  writeJson(env.OPENCLAW_CONFIG_PATH, cfg);
  setRuntimeConfigSnapshot(cfg, cfg);
  const program = new Command();
  await withEnvAsync(env, () => registerCli(program, { env, ...options }));
  return program;
}

function helpPlugin(root: string, id: string, body: string, registration: string) {
  const plugin = writePlugin({ id, dir: path.join(root, id), filename: "index.cjs", body });
  writeJson(path.join(plugin.dir, "package.json"), {
    name: id,
    openclaw: { extensions: ["./index.cjs"] },
  });
  fs.writeFileSync(
    path.join(plugin.dir, "cli-metadata.cjs"),
    `module.exports = { id: ${JSON.stringify(id)}, register(api) {\n${registration}\n} };`,
  );
  return plugin;
}

it.each([
  { label: "complete metadata", complete: true, enabled: true },
  { label: "disabled plugin", complete: true, enabled: false },
  { label: "incomplete legacy descriptors", complete: false, enabled: true },
])("keeps $label help light until runtime expansion", async ({ complete, enabled }) => {
  const { root, env } = createCliFixture();
  const loaded = path.join(root, "runtime-loaded");
  const unrelatedLoaded = path.join(root, "unrelated-runtime-loaded");
  const action = path.join(root, "action-ran");
  const descriptor = {
    name: "widget",
    description: "Fixture widget commands",
    hasSubcommands: true,
  };
  const plugin = helpPlugin(
    root,
    "nodes-help",
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(loaded)}, "full");
module.exports = { id: "nodes-help", register(api) {
  api.registerCli(({ program }) => {
    const command = program.command("widget").description("Fixture widget commands").option("--fixture-option <value>", "Runtime option");
    command.command("run").action(() => fs.writeFileSync(${JSON.stringify(action)}, "executed"));
  }, { parentPath: ["nodes"], commands: ["widget"], descriptors: [${JSON.stringify(descriptor)}] });
} };`,
    `      api.registerCli(() => {}, { parentPath: ["nodes"], commands: ["widget"], descriptors: ${JSON.stringify(complete ? [descriptor] : [])} });`,
  );
  const unrelated = helpPlugin(
    root,
    "unrelated-help",
    `require("node:fs").writeFileSync(${JSON.stringify(unrelatedLoaded)}, "full");
module.exports = { id: "unrelated-help", register(api) {
  api.registerCli(({ program }) => program.command("unrelated"), { commands: ["unrelated"] });
} };`,
    `  api.registerCli(() => {}, { commands: ["unrelated"] });`,
  );
  writeJson(env.OPENCLAW_CONFIG_PATH, {
    plugins: {
      load: { paths: [plugin.dir, unrelated.dir] },
      allow: [plugin.id, unrelated.id],
      entries: { [plugin.id]: { enabled }, [unrelated.id]: { enabled: true } },
    },
  });
  await withEnvAsync({ ...env, OPENCLAW_HOME: root }, async () => {
    const helpProgram = await nodesProgram("--help");
    const help = child(helpProgram, "nodes").helpInformation();
    expect(help.includes("Fixture widget commands")).toBe(enabled);
    expect(fs.existsSync(unrelatedLoaded)).toBe(false);
    expect(fs.existsSync(loaded)).toBe(enabled && !complete);
    if (!enabled) {
      return;
    }
    if (complete) {
      expect(child(await nodesProgram("-h"), "nodes").helpInformation()).toBe(help);
      expect(fs.existsSync(loaded)).toBe(false);
      expect(fs.existsSync(unrelatedLoaded)).toBe(false);
    }

    // Metadata registration closed its preparation; expansion must acquire full entries afresh.
    await helpProgram.parseAsync(["nodes", "widget", "run"], { from: "user" });
    expect(fs.readFileSync(action, "utf8")).toBe("executed");
    expect(fs.readFileSync(loaded, "utf8")).toBe("full");
    expect(fs.existsSync(unrelatedLoaded)).toBe(false);
    const nodes = child(await nodesProgram("widget", "--help"), "nodes");
    expect(nodes.helpInformation()).toBe(help);
    expect(child(nodes, "widget").helpInformation()).toContain("--fixture-option <value>");
    expect(fs.existsSync(unrelatedLoaded)).toBe(false);
    if (complete) {
      const session = createPluginCliLoadSession();
      try {
        for (const mode of ["metadata", "lazy", "metadata"] as const) {
          const reused = new Command().exitOverride();
          configureProgramHelp(reused, { programVersion: "fixture" });
          const parent = reused.command("nodes");
          await registerCli(reused, { env: process.env, mode, primary: "nodes", session });
          const widget = child(parent, "widget");
          expect(widget.options.some((option) => option.long === "--fixture-option")).toBe(
            mode === "lazy",
          );
        }
      } finally {
        session.close();
      }
    }
  });
});

it.each(["alpha", undefined])("validates beta-first workspaces for owner %s", async (owner) => {
  const { root, env } = createCliFixture("OPENCLAW_HOME");
  for (const id of ["alpha", "beta"]) {
    writePlugin({
      id,
      dir: path.join(root, id, ".openclaw", "extensions", id),
      filename: "index.cjs",
      registration: `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, `${id}-registered`))}, api.registrationMode); api.registerCli(({program}) => program.command(${JSON.stringify(id)}), { descriptors: [{ name: ${JSON.stringify(id)}, description: "Workspace", hasSubcommands: false }] });`,
      configSchema: stringConfigSchema("label", { additionalProperties: false }),
    });
  }
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(
        ["beta", "alpha"].map((id) => [id, { workspace: path.join(root, id) }]),
      ),
      ...(owner ? { defaults: { systemAgent: { agentId: owner } } } : {}),
    },
    plugins: { allow: ["alpha", "beta"], entries: { beta: { config: { label: "valid" } } } },
  };
  writeJson(env.OPENCLAW_CONFIG_PATH, cfg);
  await withEnvAsync(env, async () => {
    const session = createPluginCliLoadSession();
    const read = await session.readConfig(() => readBestEffortConfigSnapshot({ observe: false }));
    expect(read.configDiagnostics).toBeNull();
    expect(names(await loadPluginCliDescriptors({ cfg: read.config, session }))).toEqual(
      owner ? ["alpha"] : [],
    );
    const program = new Command();
    await registerCli(program, { session });
    expect(commandNames(program)).toEqual(owner ? ["alpha"] : []);
    expect(fs.existsSync(path.join(root, "beta-registered"))).toBe(false);
    expect(session.resolve({ cfg: read.config }).context.workspaceDir).toBe(
      owner ? path.join(root, owner) : undefined,
    );
    writeJson(env.OPENCLAW_CONFIG_PATH, {
      ...cfg,
      plugins: { ...cfg.plugins, entries: { beta: { config: { label: 17 } } } },
    });
    const rejected = new Command();
    await expect(registerCli(rejected, { session })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
      details: expect.stringContaining("plugins.entries.beta.config.label"),
    });
    expect(rejected.commands).toEqual([]);
    session.close();
  });
});

it.each(["process.env", "config", "runtime"] as const)(
  "refreshes owners and callbacks after %s mutations",
  async (input) => {
    const { root } = createCliFixture();
    const bundledDir = path.join(root, "bundled");
    const actionPath = path.join(root, "action.txt");
    const plugin = writePlugin({
      dir: path.join(bundledDir, "cli-inputs"),
      id: "cli-inputs",
      filename: "index.cjs",
      registration: `  api.registerCli(({ program }) => program.command("prepared").action(() => require("node:fs").writeFileSync(${JSON.stringify(actionPath)}, api.registrationMode)), {
    descriptors: [{ name: "prepared", description: "Prepared command", hasSubcommands: false }],
  });`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "cli-metadata.cjs"),
      'module.exports = require("./index.cjs");',
    );
    patchManifest(plugin.dir, {
      channels: [plugin.id],
      autoEnableWhenConfiguredProviders: [plugin.id],
    });
    writeJson(path.join(plugin.dir, "package.json"), {
      name: "@openclaw/cli-inputs",
      openclaw: {
        extensions: ["./index.cjs"],
        channel: { id: plugin.id, configuredState: { env: { allOf: ["CLI_INPUTS_TOKEN"] } } },
      },
    });
    await withEnvAsync(
      {
        ...cliEnv(root),
        OPENCLAW_HOME: root,
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        CLI_INPUTS_TOKEN: undefined,
      },
      async () => {
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: path.join(root, "workspace") } },
          plugins: { enabled: true },
          auth: { profiles: {} },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const gateway = resolvePluginRuntimeLoadContext({ config: cfg });
        const gatewayScope = {
          config: cfg,
          env: process.env,
          workspaceDir: gateway.workspaceDir,
        };
        setCurrentPluginMetadataSnapshot(gateway.metadataSnapshot, gatewayScope);
        const session = createPluginCliLoadSession();
        const params = { cfg, session, primaryCommand: "prepared" };
        for (const enabled of [false, true, false]) {
          if (input === "process.env") {
            setTestEnvValue("CLI_INPUTS_TOKEN", enabled ? "synthetic-token" : "");
          } else if (input === "config") {
            cfg.auth!.profiles = enabled
              ? { fixture: { provider: plugin.id, mode: "api_key" } }
              : {};
          } else {
            cfg.plugins = { enabled: true, entries: { [plugin.id]: { enabled } } };
            setRuntimeConfigSnapshot(cfg, cfg);
          }
          const expected = enabled ? ["prepared"] : [];
          expect(names(await loadPluginCliDescriptors(params))).toEqual(expected);
          expect(await resolvePluginCliRootOwnerIds(params)).toEqual(enabled ? [plugin.id] : []);
          const program = new Command();
          writeJson(path.join(root, "openclaw.json"), cfg);
          await registerCli(program, { primary: "prepared", session });
          expect(commandNames(program)).toEqual(expected);
          if (enabled) {
            await program.parseAsync(["prepared"], { from: "user" });
            expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery");
          }
          expect(getCurrentPluginMetadataSnapshot(gatewayScope)).toBe(gateway.metadataSnapshot);
        }
      },
    );
  },
);

it("does not borrow another environment's Gateway graph through config identity", async () => {
  const { root } = createCliFixture();
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { allow: ["environment-cli"], entries: { "environment-cli": { enabled: true } } },
  };
  const environments = ["gateway", "cli"].map((label) => {
    const stateDir = path.join(root, label);
    writePlugin({
      dir: path.join(stateDir, "extensions", "environment-cli"),
      id: "environment-cli",
      filename: "index.cjs",
      registration: `api.registerCli(() => {}, { descriptors: [{ name: "prepared", description: ${JSON.stringify(label)}, hasSubcommands: false }] });`,
    });
    return { HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
  });
  const gateway = resolvePluginRuntimeLoadContext({ config: cfg, env: environments[0] });
  expect(gateway.metadataSnapshot).toBeDefined();
  const gatewayScope = { config: cfg, env: environments[0], workspaceDir: gateway.workspaceDir };
  setCurrentPluginMetadataSnapshot(gateway.metadataSnapshot, gatewayScope);
  expect(
    await loadPluginCliDescriptors({
      cfg,
      env: environments[1],
      session: createPluginCliLoadSession(),
      primaryCommand: "prepared",
    }),
  ).toMatchObject([{ description: "cli" }]);
  expect(getCurrentPluginMetadataSnapshot(gatewayScope)).toBe(gateway.metadataSnapshot);
});

it.each([false, true])("reuses discovery through registration (legacy=%s)", async (legacy) => {
  const { root, env } = createCliFixture();
  const actionPath = path.join(root, "action.txt");
  const plugin = writePlugin({
    dir: path.join(root, "plugin"),
    id: "invocation-cli",
    filename: "index.cjs",
    registration: `    api.registerCli(({ program }) => program.command("prepared").action(() => require("node:fs").writeFileSync(${JSON.stringify(actionPath)}, api.registrationMode + ":" + api.pluginConfig.label)), {
      descriptors: [{ name: "prepared", description: "Prepared command", hasSubcommands: false, machineOutput: () => true }],
    });`,
    configSchema: requiredLabel,
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  if (!legacy) {
    patchManifest(plugin.dir, {
      cliCommands: [{ name: "prepared", description: "Prepared command", hasSubcommands: false }],
    });
  }
  const cfg = pluginConfig(plugin, { enabled: true, config: { label: "first" } });
  writeJson(env.OPENCLAW_CONFIG_PATH, cfg);
  setRuntimeConfigSnapshot(cfg, cfg);
  const session = createPluginCliLoadSession();
  // This invocation already validated the manifest before removing it below.
  const options = { primary: "prepared", skipPluginValidation: true, session };
  const params = { cfg, env, primaryCommand: "prepared", session };
  const descriptors = await loadPluginCliDescriptors(params);
  expect(descriptors[0]?.machineOutput?.({ argv: [], stdoutIsTTY: true })).toBe(true);
  fs.unlinkSync(manifestPath);
  expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
  const program = new Command();
  await withEnvAsync(env, () => registerCli(program, { env, ...options }));
  expect(commandNames(program)).toEqual(["prepared"]);
  await program.parseAsync(["prepared"], { from: "user" });
  expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery:first");
  const changedConfig = pluginConfig(plugin, { enabled: true, config: { label: "second" } });
  const changedProgram = await configuredProgram(changedConfig, env, options);
  await changedProgram.parseAsync(["prepared"], { from: "user" });
  expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery:second");
  expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  expect(
    await resolvePluginCliRootOwnerIds({ ...params, session: createPluginCliLoadSession() }),
  ).toEqual([]);
});

it("isolates changed workspace and policy within an invocation", async () => {
  const { root, env } = createCliFixture();
  const createWorkspace = (label: string) => {
    const workspace = path.join(root, label);
    writePlugin({
      dir: path.join(workspace, ".openclaw", "extensions", "workspace-cli"),
      id: "workspace-cli",
      filename: "index.cjs",
      registration: `          api.registerCli(({ program }) => program.command("prepared").description(${JSON.stringify(label)}), {
            descriptors: [{ name: "prepared", description: ${JSON.stringify(label)}, hasSubcommands: false }],
          });`,
    });
    return workspace;
  };
  const firstWorkspace = createWorkspace("first");
  const secondWorkspace = createWorkspace("second");
  const config = (workspace: string, enabled = true): OpenClawConfig => ({
    agents: { defaults: { workspace } },
    plugins: { allow: ["workspace-cli"], entries: { "workspace-cli": { enabled } } },
  });
  const session = createPluginCliLoadSession();
  const scope = { env, session, primaryCommand: "prepared" };
  expect(await loadPluginCliDescriptors({ ...scope, cfg: config(firstWorkspace) })).toMatchObject([
    { description: "first" },
  ]);
  const cfg = config(secondWorkspace);
  const params = { ...scope, cfg };
  expect(await loadPluginCliDescriptors(params)).toMatchObject([{ description: "second" }]);
  expect(await resolvePluginCliRootOwnerIds(params)).toEqual(["workspace-cli"]);
  const program = await configuredProgram(cfg, env, { primary: "prepared", session });
  expect(program.commands.map((command) => command.description())).toEqual(["second"]);
  const disabled = config(secondWorkspace, false);
  expect(await loadPluginCliDescriptors({ ...params, cfg: disabled })).toEqual([]);
  expect(await resolvePluginCliRootOwnerIds({ ...params, cfg: disabled })).toEqual([]);
  const disabledProgram = await configuredProgram(disabled, env, {
    primary: "prepared",
    session,
  });
  expect(disabledProgram.commands).toEqual([]);
  expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
});

it.each(["enabled", "disabled", "invalid"] as const)(
  "reuses supplied manifests with %s policy",
  async (policy) => {
    const { root } = createCliFixture();
    const plugin = writePlugin({
      id: "prepared-cli",
      dir: path.join(root, "plugin"),
      filename: "index.cjs",
      configSchema: { ...requiredLabel, additionalProperties: false },
      registration: `api.registerCli(({ program }) => program.command("prepared").description(api.pluginConfig.label), {
          descriptors: [{ name: "prepared", description: api.pluginConfig.label, hasSubcommands: false }],
        });`,
    });
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const config = pluginConfig(plugin, {
      enabled: policy !== "disabled",
      config: { label: policy === "invalid" ? 42 : "Prepared command" },
    });
    const manifestRegistry = loadPluginManifestRegistryCore({ config, env });
    expect(manifestRegistry.plugins.map((entry) => entry.id)).toEqual([plugin.id]);
    // The caller owns this graph; subsequent discovery cannot recover the removed manifest.
    fs.unlinkSync(path.join(plugin.dir, "openclaw.plugin.json"));
    const registry = await loadOpenClawPluginCliRegistry({
      config,
      env,
      manifestRegistry,
      installRecords: {},
    });
    expect(registry.plugins.map((entry) => [entry.id, entry.status])).toEqual([
      [plugin.id, policy === "enabled" ? "loaded" : policy === "disabled" ? "disabled" : "error"],
    ]);
    expect(registry.cliRegistrars.flatMap((entry) => entry.commands)).toEqual(
      policy === "enabled" ? ["prepared"] : [],
    );
  },
);

const countRegisterRuns = (markerPath: string) =>
  fs.readFileSync(markerPath, "utf8").split("\n").filter(Boolean).length;

function setupCountingCliPlugin(): { config: OpenClawConfig; markerPath: string } {
  useNoBundledPlugins();
  const markerPath = path.join(makePluginLoaderTempDir(), "register-runs.log");
  const { file } = writePlugin({
    id: "counting-cli",
    filename: "index.cjs",
    registration: `    require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, "register\\n");
    api.registerCli(() => {}, {
      commands: ["counting-cli"],
      descriptors: [{ name: "counting-cli", description: "Counting CLI", hasSubcommands: false }],
    });`,
  });
  return {
    config: { plugins: { load: { paths: [file] }, allow: ["counting-cli"] } },
    markerPath,
  };
}

it("registers an unrelated command without the Gateway's PostgreSQL credentials", async () => {
  const { config } = setupCountingCliPlugin();
  config.database = {
    engine: "postgres",
    postgres: { connection: { source: "env", provider: "default", id: "UNAVAILABLE_CLI_DSN" } },
  };
  const session = createPluginCliLoadSession();
  onTestFinished(() => session.close());
  const entries = await loadPluginCliRegistrationEntriesWithDefaults({
    cfg: config,
    env: {},
    primaryCommand: "counting-cli",
    session,
  });
  expect(entries.map((entry) => entry.pluginId)).toEqual(["counting-cli"]);
});

it.each([
  { outcome: "success", failure: undefined },
  { outcome: "Error", failure: { reason: new Error("Metadata cleanup failed") } },
  { outcome: "undefined", failure: { reason: undefined } },
])("joins CLI-owned source metadata disposal ($outcome)", async ({ failure }) => {
  useNoBundledPlugins();
  const { dir: pluginDir } = writePlugin({
    id: "owned-cli-metadata",
    filename: "index.cjs",
    body: 'throw new Error("Full runtime must not load for metadata help");',
  });
  writePlugin({
    id: "owned-cli-metadata",
    dir: pluginDir,
    filename: "cli-metadata.cjs",
    registration: `    api.registerCli(() => {}, {
      parentPath: ["nodes"],
      descriptors: [{ name: "owned-metadata", description: "Synthetic metadata", hasSubcommands: false }],
    });`,
  });
  const cache = createPluginCache();
  const resources = new CliPluginInvocationResources();
  const session = createPluginCliLoadSession(cache, { resources });
  const config: OpenClawConfig = {
    plugins: { allow: ["owned-cli-metadata"], load: { paths: [pluginDir] } },
  };
  const params = { cfg: config, env: process.env, primaryCommand: "nodes", session };
  const removalStarted = createDeferredCore();
  const finishRemoval = createDeferredCore();
  let instance: ReturnType<typeof getPluginInstance> = undefined;
  let releasing: Promise<void> | undefined;
  let disposals = 0;
  let siblingDisposals = 0;
  try {
    const entries = await loadPluginCliRegistrationEntriesWithDefaults(params, "metadata");
    expect(entries).toMatchObject([
      { parentPath: ["nodes"], placeholders: [{ name: "owned-metadata" }] },
    ]);
    const registry = await session.resolve(params).metadataRegistry;
    const record = registry?.plugins.find((entry) => entry.id === "owned-cli-metadata");
    instance = record && getPluginInstance(record);
    if (!instance) {
      throw new Error("Expected the registered metadata instance");
    }
    instance.onModuleDispose(() => {
      siblingDisposals++;
    });
    instance.onModuleDispose(async () => {
      disposals++;
      removalStarted.resolve();
      await finishRemoval.promise;
      if (failure) {
        // oxlint-disable-next-line typescript/only-throw-error -- Preserve disposal failures with literal undefined reasons.
        throw failure.reason;
      }
    });
    session.close();
    let released = false;
    releasing = resources.release();
    expect(resources.release()).toBe(releasing);
    const markReleased = <T>(result: T) => {
      released = true;
      return result;
    };
    const outcome = releasing.then(
      () => markReleased({ ok: true as const }),
      (error: unknown) => markReleased({ ok: false as const, error }),
    );
    await Promise.race([
      removalStarted.promise,
      outcome.then(() => {
        throw new Error("CLI invocation released before metadata disposal started");
      }),
    ]);
    expect([released, disposals, siblingDisposals]).toEqual([false, 1, 0]);
    finishRemoval.resolve();
    const result = await outcome;
    expect(result.ok).toBe(!failure);
    if (!result.ok && failure) {
      expect(hasRetainedPluginRuntimeCloseError(result.error)).toBe(false);
      expect(
        collectNestedErrorCandidates(result.error).some(
          (candidate) =>
            candidate instanceof AggregateError && candidate.errors.includes(failure.reason),
        ),
      ).toBe(true);
    }
    expect(resources.release()).toBe(releasing);
    expect([disposals, siblingDisposals]).toEqual([1, 1]);
  } finally {
    finishRemoval.resolve();
    session.close();
    await releasing?.catch(() => {});
    await resources.release().catch(() => {});
    await instance?.dispose();
    await retirePluginCache(cache);
  }
});

it("runs a legacy external plugin register once across CLI bootstrap stages", async () => {
  const { config, markerPath } = setupCountingCliPlugin();
  const session = createPluginCliLoadSession();
  onTestFinished(() => session.close());
  const params = { cfg: config, env: process.env, primaryCommand: "counting-cli", session };
  const ownerIds = await resolvePluginCliRootOwnerIds(params);
  const descriptors = await loadPluginCliDescriptors(params);
  expect(ownerIds).toEqual(["counting-cli"]);
  expect(descriptors.map((entry) => entry.name)).toContain("counting-cli");
  expect(countRegisterRuns(markerPath)).toBe(1);
});

it("keeps distinct load scopes on separate register passes", async () => {
  const { config, markerPath } = setupCountingCliPlugin();
  await loadPluginCliDescriptors({ cfg: config, env: process.env });
  await getPluginCliCommandDescriptors(config, process.env);
  expect(countRegisterRuns(markerPath)).toBe(2);
});
