import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeFixtureJson } from "../cli/cli-fixtures.test-support.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const withHome = useDoctorConfigPreflightHome();
afterEach(() => closeOpenClawStateDatabaseForTest());

it.each(["doctor", "startup", "rejected-startup"] as const)(
  "releases external Doctor source captures after %s finishes",
  async (operation) => {
    await withHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const pluginId = "capture-fixture";
        const pluginDir = path.join(home, "plugin");
        const marker = path.join(home, "loaded-captures");
        await fs.mkdir(pluginDir);
        await fs.writeFile(path.join(pluginDir, "index.cjs"), "exports.register = () => {};\n");
        await writeFixtureJson(path.join(pluginDir, "openclaw.plugin.json"), {
          id: pluginId,
          doctorContract: { configRepair: true },
          configSchema: { type: "object", additionalProperties: false },
        });
        await fs.writeFile(
          path.join(pluginDir, "doctor-contract-api.cjs"),
          `require("node:fs").appendFileSync(${JSON.stringify(marker)}, __dirname + "\\n");
exports.legacyConfigRules = [{
  path: ["plugins", "entries", "${pluginId}", "config", "retired"],
  message: "Remove the retired fixture setting."
}];\n`,
        );
        const config = {
          gateway: { mode: "local" as const },
          plugins: {
            allow: [pluginId],
            load: { paths: [pluginDir] },
            entries: {
              [pluginId]: {
                enabled: true,
                config: { retired: true },
              },
            },
          },
          meta: { migrations: { webhookListeners: true as const } },
        };
        await writeFixtureJson(path.join(home, ".openclaw", "openclaw.json"), config);
        await seedInstalledPluginIndex({}, { config });

        const captures = async () => (await fs.readFile(marker, "utf8")).trim().split("\n");
        {
          // Doctor also borrows the invocation cache for legacy config inspection.
          await using invoking = createPluginCache();
          await withPluginCache(invoking, async () => {
            if (operation === "rejected-startup") {
              await expect(
                runStartupConfigPreflight({
                  gateway: false,
                  observe: false,
                  beforeStatePreparation: async () => false,
                }),
              ).rejects.toThrow("selected config changed");
            } else {
              const result =
                operation === "doctor"
                  ? await runDoctorConfigPreflight({
                      migrateLegacyConfig: false,
                      preparePluginMetadataSnapshot: true,
                      observe: false,
                    })
                  : await runStartupConfigPreflight({ gateway: false, observe: false });
              await result.pluginCache?.[Symbol.asyncDispose]();
            }
          });
        }
        for (const directory of new Set(await captures())) {
          expect(directory).not.toBe(pluginDir);
          await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    });
  },
);
