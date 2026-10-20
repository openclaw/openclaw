import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const runtimeId = "fixture-cli";
const pluginId = "runtime-owner";
const config: OpenClawConfig = {
  gateway: { mode: "local" },
  agents: { defaults: { models: { "example/starter": { agentRuntime: { id: runtimeId } } } } },
};
const pending: DeferredPluginMigration = {
  pluginId: runtimeId,
  reason: "The configured plugin package is missing or has not converged.",
  command: "openclaw update repair",
};

const doctorOptions = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  repairPrefixedConfig: true,
  doctorOnlyStateMigrations: true,
} as const;

async function withRuntimeOwner(
  overrides: OpenClawConfig & { legacyFixture?: { retained: boolean } },
  run: (configPath: string) => Promise<void>,
  migration = pending,
) {
  await withDoctorConfigPreflightHome(async (home) => {
    const bundled = path.join(home, "bundled");
    const root = path.join(bundled, pluginId);
    await fs.mkdir(root, { recursive: true });
    const writeJson = (name: string, value: unknown) =>
      fs.writeFile(path.join(root, name), JSON.stringify(value));
    await writeJson("package.json", {
      name: pluginId,
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    });
    await fs.writeFile(path.join(root, "index.cjs"), "module.exports = {};\n");
    await writeJson("openclaw.plugin.json", {
      id: pluginId,
      enabledByDefault: true,
      doctorContract: {},
      cliBackends: [runtimeId],
      configSchema: { type: "object", additionalProperties: false },
    });
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ ...config, ...overrides }));
    await recordDeferredPluginMigrations({ pending: [migration] });
    await withEnvAsync({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundled }, () => run(configPath));
  });
}

it.each(["missing-fixture", runtimeId])(
  "reconciles the missing plugin %s separately from its runtime",
  async (missingId) => {
    await withRuntimeOwner(
      {
        ...(missingId !== runtimeId ? { meta: { migrations: { webhookListeners: true } } } : {}),
        plugins: { entries: { [missingId]: { enabled: true, config: { retained: true } } } },
      },
      async (configPath) => {
        if (missingId !== runtimeId) {
          const retained = readDeferredPluginMigrations();
          const original = await fs.readFile(configPath, "utf8");
          const startup = await runStartupConfigPreflight({ gateway: true, observe: false });
          expect(startup.snapshot.valid).toBe(true);
          expect(readDeferredPluginMigrations()).toEqual(retained);
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
        }
        const result = await runDoctorConfigPreflight(doctorOptions);
        expect(result.snapshot.valid).toBe(true);
        expect(readDeferredPluginMigrations().map((record) => record.pluginId)).toEqual([
          missingId,
        ]);
        expect(result.stateMigrationStepReceipts).toContainEqual(
          expect.objectContaining({ id: `plugin:${missingId}`, outcome: "deferred" }),
        );
        if (missingId !== runtimeId) {
          expect(result.stateMigrationStepReceipts).not.toContainEqual(
            expect.objectContaining({ id: `plugin:${runtimeId}`, outcome: "deferred" }),
          );
        }
      },
    );
  },
);

it("preserves runtime alias inputs excluded from validation", async () => {
  const obligation = { validationExcludedPaths: [["legacyFixture"]] };
  const protectedConfig = { legacyFixture: { retained: true } };
  await withRuntimeOwner(
    protectedConfig,
    async (configPath) => {
      const result = await runDoctorConfigPreflight(doctorOptions);
      expect(result.snapshot.valid).toBe(true);
      expect(readDeferredPluginMigrations()).toEqual([
        expect.objectContaining({ pluginId: runtimeId, ...obligation }),
      ]);
      expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject(protectedConfig);
    },
    { ...pending, ...obligation },
  );
});
