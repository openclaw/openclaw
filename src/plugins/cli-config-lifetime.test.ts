import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readBestEffortConfigSnapshot } from "../config/config.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
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
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import * as discovery from "./discovery.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("CLI config producer lifetime", () => {
  it.each(["empty", "missing", "missing-provider", "missing-direct-provider"] as const)(
    "owns discovery from the first %s config read through validated registration",
    async (kind) => {
      const { root, configPath, env } = createCliFixture("OPENCLAW_HOME");
      const bundledDir = path.join(root, "bundled");
      const actionPath = path.join(root, "action.txt");
      const descriptor =
        '{ name: "prepared", description: "Prepared command", hasSubcommands: false }';
      const plugin = writePlugin({
        id: "cold-cli",
        dir: path.join(bundledDir, "cold-cli"),
        filename: "index.cjs",
        body: `module.exports = { id: "cold-cli", register(api) {
          api.registerCli(({ program }) => program.command("prepared").action(() => require("node:fs").writeFileSync(${JSON.stringify(actionPath)}, api.registrationMode)), { descriptors: [${descriptor}] });
        } };`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "cli-metadata.cjs"),
        `module.exports = { id: "cold-cli", register(api) {
        api.registerCli(() => {}, { descriptors: [{ ...${descriptor}, machineOutput: () => true }] });
      } };`,
      );
      patchManifest(plugin.dir, {
        enabledByDefault: true,
        cliCommands: [{ name: "prepared", description: "Prepared command", hasSubcommands: false }],
      });
      if (kind.includes("provider")) {
        const owner = writePlugin({
          id: "defaults-owner",
          dir: path.join(
            bundledDir,
            kind === "missing-direct-provider" ? "anthropic" : "defaults-owner",
          ),
          filename: "index.cjs",
          body: 'throw new Error("provider runtime must not load for config defaults");',
        });
        writeJson(path.join(owner.dir, "openclaw.plugin.json"), {
          id: owner.id,
          providers: ["anthropic"],
          configSchema: { type: "object", properties: {} },
        });
        fs.writeFileSync(
          path.join(owner.dir, "provider-policy-api.js"),
          'export const applyConfigDefaults = ({ config }) => ({ ...config, agents: { ...config.agents, defaults: { ...config.agents.defaults, contextPruning: { mode: "cache-ttl", ttl: "7m" } } } });',
        );
      }
      if (kind === "empty") {
        fs.writeFileSync(configPath, "{}");
      }
      await withEnvAsync(
        {
          ...env,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          ANTHROPIC_API_KEY: kind.includes("provider") ? "synthetic-token" : undefined,
          ANTHROPIC_OAUTH_TOKEN: undefined,
        },
        async () => {
          const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
          const session = createPluginCliLoadSession();
          const read = await session.readConfig(() =>
            readBestEffortConfigSnapshot({ observe: false, skipPluginValidation: true }),
          );
          expect(read.configDiagnostics).toBeNull();
          expect(read.sourceConfig.agents?.defaults?.compaction).toBeUndefined();
          expect(read.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
          if (kind === "missing" || kind === "missing-direct-provider") {
            expect(discover).not.toHaveBeenCalled();
          }
          if (kind.includes("provider")) {
            expect(read.config.agents?.defaults?.contextPruning?.ttl).toBe("7m");
          }
          // Enable the fixture only after proving missing/empty defaults.
          const enabledConfig = { ...read.config, plugins: { enabled: true, allow: [plugin.id] } };
          writeJson(configPath, { plugins: enabledConfig.plugins });
          const params = { cfg: enabledConfig, session, primaryCommand: "prepared" };
          const descriptors = await loadPluginCliDescriptors(params);
          expect(descriptors[0]?.machineOutput?.({ argv: [], stdoutIsTTY: true })).toBe(true);
          expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
          expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
          const program = new Command();
          expect(await registerCli(program, { primary: "prepared", session })).not.toBeNull();
          expect(program.commands.map((command) => command.name())).toEqual(["prepared"]);
          session.close();
          program.hook("preAction", clearPluginMetadataLifecycleCaches);
          await session.withCache(() => program.parseAsync(["prepared"], { from: "user" }));
          expect(fs.readFileSync(actionPath, "utf8")).toBe("discovery");
          expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
          expect(() => session.resolve(params)).toThrow(/preparation is closed/);
          if (kind === "missing-provider") {
            const previousDiscoveries = discover.mock.calls.length;
            fs.unlinkSync(configPath);
            const core = await readConfigFileSnapshotFromContext(
              createConfigIoContext({
                env: process.env,
                observe: false,
                pluginValidation: "core-only",
              }),
            );
            expect(core.runtimeConfig.agents?.defaults?.contextPruning).toBeUndefined();
            expect(discover).toHaveBeenCalledTimes(previousDiscoveries);
          }
        },
      );
    },
  );
  it("keeps skipped validation lazy but rejects an invalid plugin at the fresh registration read", async () => {
    const { root, configPath, env } = createCliFixture("OPENCLAW_HOME");
    const plugin = writePlugin({
      id: "invalid-cli",
      dir: path.join(root, "plugin"),
      filename: "index.cjs",
      configSchema: stringConfigSchema("label", { additionalProperties: false }),
      body: 'throw new Error("invalid plugin must not execute");',
    });
    const rule = {
      path: ["plugins", "entries", plugin.id, "config", "label"],
      message: "Migrate the legacy numeric label to a string.",
    };
    fs.writeFileSync(
      path.join(plugin.dir, "doctor-contract-api.cjs"),
      `module.exports = { legacyConfigRules: [${JSON.stringify(rule)}] };`,
    );
    writeJson(configPath, pluginConfig(plugin, { config: { label: 17 } }));
    await withEnvAsync(env, async () => {
      const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
      const session = createPluginCliLoadSession();
      const read = await session.readConfig(() =>
        readBestEffortConfigSnapshot({ observe: false, skipPluginValidation: true }),
      );
      expect(read.configDiagnostics).toBeNull();
      expect(discover).not.toHaveBeenCalled();
      const invalid = await session.readConfig(() =>
        readConfigFileSnapshotFromContext(createConfigIoContext({ env: process.env })),
      );
      expect(invalid.valid).toBe(false);
      expect(invalid.legacyIssues).toEqual([{ path: rule.path.join("."), message: rule.message }]);
      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
      const program = new Command();
      await expect(registerCli(program, { session, primary: "prepared" })).rejects.toMatchObject({
        code: "INVALID_CONFIG",
        details: expect.stringContaining("plugins.entries.invalid-cli.config.label"),
      });
      expect(program.commands).toEqual([]);
      session.close();
    });
  });
  it("publishes validated config before plugin CLI registration reads it", async () => {
    const { root, configPath, env } = createCliFixture("OPENCLAW_HOME");
    const id = "runtime-config-cli";
    const plugin = writePlugin({
      id,
      dir: path.join(root, "plugin"),
      filename: "index.cjs",
      configSchema: stringConfigSchema("command", { additionalProperties: false }),
      body: `module.exports = { id: "${id}", register(api) {
        const name = api.runtime.config.current().plugins.entries["${id}"].config.command;
        api.registerCli(({ program }) => program.command(name), { descriptors: [{ name, description: "Live config command", hasSubcommands: false }] });
      } };`,
    });
    patchManifest(plugin.dir, {
      cliCommands: [
        { name: "live-config", description: "Live config command", hasSubcommands: false },
      ],
    });
    const cfg = pluginConfig(plugin, { enabled: true, config: { command: "live-config" } });
    writeJson(configPath, { ...cfg, plugins: { ...cfg.plugins, enabled: true } });
    await withEnvAsync(env, async () => {
      clearRuntimeConfigSnapshot();
      const program = new Command();
      await registerCli(program, { primary: "live-config" });
      expect(program.commands.map((command) => command.name())).toEqual(["live-config"]);
    });
  });
});

function makeEnvironment() {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  return {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

it.each(["system-agent", "install-roots", "install-state"] as const)(
  "prepares %s scopes without mutating the supplied config or env",
  async (kind) => {
    const env = makeEnvironment();
    const at = (...parts: string[]) => path.join(env.HOME, ...parts);
    const ids = ["alpha", "beta"];
    const entries = Object.fromEntries(ids.map((id) => [id, { workspace: at(id) }]));
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries },
      plugins: { allow: ids },
    };
    for (const id of ids) {
      const installPath = at(id, ".openclaw", "extensions", id);
      writePlugin({
        id,
        dir: installPath,
        filename: "index.cjs",
        body: `module.exports = { id: ${JSON.stringify(id)}, register(api) { api.registerCli(({ program }) => program.command(${JSON.stringify(id)}), { descriptors: [{ name: ${JSON.stringify(id)}, description: "Scope", hasSubcommands: false }] }); } };`,
      });
    }
    if (kind === "install-state") {
      for (const id of ids) {
        const installPath = at(id, ".openclaw", "extensions", id);
        await refreshPersistedInstalledPluginIndex({
          config: cfg,
          env,
          stateDir: at(id, "state"),
          reason: "source-changed",
          installRecords: { [id]: { source: "path", installPath, sourcePath: installPath } },
        });
      }
    }
    const session = createPluginCliLoadSession();
    const params = { cfg, env, session };
    let previous: Awaited<ReturnType<typeof loadPluginCliRegistrationEntriesWithDefaults>> = [];
    for (const id of ids) {
      const run = async () => {
        const serialized = JSON.stringify([cfg, env]);
        expect((await loadPluginCliDescriptors(params)).map(({ name }) => name)).toEqual([id]);
        previous = await loadPluginCliRegistrationEntriesWithDefaults(params);
        const program = new Command();
        await previous[0]!.register(program);
        expect(program.commands.map((command) => command.name())).toEqual([id]);
        expect(JSON.stringify([cfg, env])).toBe(serialized);
      };
      if (kind === "system-agent") {
        cfg.agents!.defaults = { systemAgent: { agentId: id } };
        await run();
      } else {
        await withPluginInstallRoots(
          {
            extensionsDir: at(kind === "install-state" ? "shared" : id, ".openclaw", "extensions"),
            gitDir: at("shared", "git"),
            npmDir: at("shared", "npm"),
            stateDir: at(id, "state"),
          },
          run,
        );
      }
    }
    session.close();
    await expect(previous[0]!.register(new Command())).rejects.toThrow(/preparation is closed/);
    expect(() => session.resolve({ cfg, env })).toThrow(/preparation is closed/);
  },
);

it("retains the exact new config object when a fresh read has identical serialized values", () => {
  const env = makeEnvironment();
  const cfg = { plugins: { enabled: false } };
  const fresh = { ...cfg };
  const session = createPluginCliLoadSession();
  session.resolve({ cfg, env });
  const next = session.resolve({ cfg: fresh, env });
  expect(next.context.rawConfig).toBe(fresh);
  expect(next.context.activationSourceConfig).toBe(fresh);
  const freshEnv = { ...env };
  const changedEnv = session.resolve({ cfg: fresh, env: freshEnv });
  expect(changedEnv).not.toBe(next);
  session.close();
});
