import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createCliFixture,
  patchManifest,
  pluginConfig,
  registerCli,
  writeJson,
} from "./cli-lifetime.test-support.js";
import { createPluginCliLoadSession, loadPluginCliDescriptors } from "./cli-registry-loader.js";
import { cleanupPluginLoaderFixturesForTest, writePlugin } from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache } from "./plugin-cache.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "./runtime-degraded-state.js";

afterAll(cleanupPluginLoaderFixturesForTest);
afterEach(async () => {
  await closeStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it.each(["pending", "lazy", "normal", "disabled", "denied", "quarantined", "failed"] as const)(
  "keeps recovery-only registration within existing CLI admission (%s)",
  async (policy) => {
    const { root, env, configPath } = createCliFixture("OPENCLAW_HOME");
    fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    const full = path.join(root, "full-import");
    const doctor = path.join(root, "doctor-import");
    const action = path.join(root, "action");
    const plugin = writePlugin({
      id: "recovery-fixture",
      filename: "index.cjs",
      body:
        policy === "failed"
          ? 'throw new Error("ordinary load failed");'
          : `
        require("node:fs").writeFileSync(${JSON.stringify(full)}, "loaded");
        module.exports = { id: "recovery-fixture", register(api) {
          api.registerCli(({ program }) => program.command("fixture").command("ordinary"), {
            descriptors: [{ name: "fixture", description: "Fixture", hasSubcommands: true }]
          });
        } };`,
    });
    patchManifest(plugin.dir, {
      cliCommands: [{ name: "fixture", description: "Fixture", hasSubcommands: true }],
      doctorContract: { recoveryCli: [["fixture", "doctor"]], stateMigrations: true },
    });
    fs.writeFileSync(
      path.join(plugin.dir, "doctor-contract-api.cjs"),
      `
      require("node:fs").writeFileSync(${JSON.stringify(doctor)}, "loaded");
      module.exports = {
        stateMigrations: [{ id: "pending", label: "Pending", detectLegacyState() { throw new Error("must not detect from CLI"); }, migrateLegacyState() { throw new Error("must not migrate from CLI"); } }],
        registerRecoveryCli({ program }) {
          program.command("inspect").action(() => require("node:fs").writeFileSync(${JSON.stringify(action)}, "inspected"));
        }
      };`,
    );
    const config = pluginConfig(plugin, { enabled: policy !== "disabled" });
    if (policy === "denied") {
      config.plugins!.deny = [plugin.id];
    }
    writeJson(configPath, config);
    if (policy !== "normal" && policy !== "failed") {
      await recordDeferredPluginMigrations({
        env: process.env,
        pending: [
          {
            pluginId: plugin.id,
            reason: "Fixture data needs repair",
            command: "openclaw doctor --fix",
            requiresStateMigration: true,
          },
        ],
      });
    }
    const previous = listActiveDegradedPlugins();
    if (policy === "quarantined") {
      setActiveDegradedPlugins(
        buildDegradedPluginsFromVerificationFailures([
          {
            pluginId: plugin.id,
            installPath: plugin.dir,
            reason: "missing-main-entry",
            detail: "Quarantined fixture",
          },
        ]),
      );
    }
    const cache = createPluginCache();
    const session = createPluginCliLoadSession(cache);
    const program = new Command().exitOverride().configureOutput({ writeErr() {} });
    try {
      const recovery = policy === "pending" || policy === "lazy";
      const descriptors = await loadPluginCliDescriptors({
        cfg: config,
        session,
        primaryCommand: "fixture",
      });
      expect(descriptors.map(({ name }) => name)).toEqual(
        recovery || policy === "normal" ? ["fixture"] : [],
      );
      expect(fs.existsSync(action)).toBe(false);
      await registerCli(program, {
        session,
        primary: "fixture",
        mode: policy === "lazy" ? "metadata" : "lazy",
      });
      session.close();
      expect(program.commands.map((command) => command.name())).toEqual(
        recovery || policy === "normal" ? ["fixture"] : [],
      );
      if (recovery) {
        await session.withCache(() =>
          program.parseAsync(["fixture", "doctor", "inspect"], { from: "user" }),
        );
        expect(fs.readFileSync(action, "utf8")).toBe("inspected");
        expect(program.commands[0]?.commands.map((command) => command.name())).toEqual(["doctor"]);
        await retirePluginCache(cache);
        await expect(
          program.parseAsync(["fixture", "doctor", "inspect"], { from: "user" }),
        ).rejects.toThrow();
      }
      expect(fs.existsSync(full)).toBe(policy === "normal");
      expect(fs.existsSync(doctor)).toBe(recovery);
    } finally {
      session.close();
      await retirePluginCache(cache);
      setActiveDegradedPlugins(previous);
    }
  },
);
