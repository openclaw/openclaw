import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfigPreflightSnapshot } from "./config-preflight-snapshot.js";
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

async function withRuntimeOwner(run: (configPath: string) => Promise<void>) {
  await withDoctorConfigPreflightHome(async (home) => {
    const bundled = path.join(home, "bundled");
    const root = path.join(bundled, pluginId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: pluginId,
        version: "1.0.0",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fs.writeFile(path.join(root, "index.cjs"), "module.exports = {};\n");
    await fs.writeFile(
      path.join(root, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        enabledByDefault: true,
        doctorContract: {},
        cliBackends: [runtimeId],
        configSchema: {
          type: "object",
          properties: { retained: { type: "boolean" } },
          additionalProperties: false,
        },
      }),
    );
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config));
    await withEnvAsync({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundled }, () => run(configPath));
  });
}

describe("runtime plugin migration ownership", () => {
  it.each([
    { facts: "prepared-empty", includePluginMetadata: false, valid: false },
    { facts: "provided-pending", includePluginMetadata: true, valid: true },
  ] as const)(
    "validates with $facts migration facts (metadata: $includePluginMetadata)",
    async ({ facts, includePluginMetadata, valid }) => {
      await withRuntimeOwner(async (configPath) => {
        const retained = { ...pending, validationExcludedPaths: [["legacyFixture"]] };
        await recordDeferredPluginMigrations({ pending: [retained] });
        const raw = JSON.stringify({ ...config, legacyFixture: { enabled: true } });
        await fs.writeFile(configPath, raw);
        const result = await readConfigPreflightSnapshot({
          purpose: "doctor",
          allowCurrentPluginMetadata: false,
          includePluginMetadata,
          skipPluginValidation: false,
          observe: false,
          ...(facts === "prepared-empty"
            ? { preparePluginMigrations: async () => [] }
            : { deferredPluginMigrations: [retained] }),
        });
        expect(result.snapshot.valid).toBe(valid);
        if (!valid) {
          expect(result.snapshot.issues).toContainEqual(
            expect.objectContaining({ message: expect.stringContaining("legacyFixture") }),
          );
        }
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        expect(readDeferredPluginMigrations()).toEqual([retained]);
      });
    },
  );

  it("startup preserves the runtime record until Doctor reconciles its owner", async () => {
    await withRuntimeOwner(async (configPath) => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          ...config,
          meta: { migrations: { webhookListeners: true } },
          plugins: {
            entries: { "missing-fixture": { enabled: true, config: { retained: true } } },
          },
        }),
      );
      await recordDeferredPluginMigrations({ pending: [pending] });
      const retained = readDeferredPluginMigrations();
      const original = await fs.readFile(configPath, "utf8");
      const startup = await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(startup.snapshot.valid).toBe(true);
      expect(readDeferredPluginMigrations()).toEqual(retained);
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      const result = await runDoctorConfigPreflight(doctorOptions);
      expect(result.snapshot.valid).toBe(true);
      expect(readDeferredPluginMigrations().map((record) => record.pluginId)).toEqual([
        "missing-fixture",
      ]);
      expect(result.stateMigrationStepReceipts).toContainEqual(
        expect.objectContaining({ id: "plugin:missing-fixture", outcome: "deferred" }),
      );
      expect(result.stateMigrationStepReceipts).not.toContainEqual(
        expect.objectContaining({ id: `plugin:${runtimeId}`, outcome: "deferred" }),
      );
    });
  });

  it.each([
    { requiresStateMigration: true as const },
    { requiresDoctorInspection: true as const },
    { configPaths: [["plugins", "entries", runtimeId, "config"]] },
    { validationExcludedPaths: [["legacyFixture"]] },
  ])("preserves a retained obligation %j", async (obligation) => {
    await withRuntimeOwner(async (configPath) => {
      const protectedConfig =
        "configPaths" in obligation
          ? {
              plugins: { entries: { [runtimeId]: { enabled: false, config: { retained: true } } } },
            }
          : "validationExcludedPaths" in obligation
            ? { legacyFixture: { retained: true } }
            : undefined;
      if (protectedConfig) {
        await fs.writeFile(configPath, JSON.stringify({ ...config, ...protectedConfig }));
      }
      await recordDeferredPluginMigrations({ pending: [{ ...pending, ...obligation }] });
      const result = await runDoctorConfigPreflight(doctorOptions);
      expect(result.snapshot.valid).toBe(true);
      expect(readDeferredPluginMigrations()).toEqual([
        expect.objectContaining({ pluginId: runtimeId, ...obligation }),
      ]);
      if (protectedConfig) {
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject(protectedConfig);
      }
    });
  });

  it("keeps an explicitly configured missing plugin separate from a runtime with the same name", async () => {
    await withRuntimeOwner(async (configPath) => {
      await fs.writeFile(
        configPath,
        JSON.stringify({
          ...config,
          plugins: { entries: { [runtimeId]: { enabled: true, config: { retained: true } } } },
        }),
      );
      await recordDeferredPluginMigrations({ pending: [pending] });
      const result = await runDoctorConfigPreflight(doctorOptions);
      expect(result.snapshot.valid).toBe(true);
      expect(readDeferredPluginMigrations().map((record) => record.pluginId)).toEqual([runtimeId]);
      expect(result.stateMigrationStepReceipts).toContainEqual(
        expect.objectContaining({ id: `plugin:${runtimeId}`, outcome: "deferred" }),
      );
    });
  });

  it("reconciles a false runtime record that retained only the shared session locator", async () => {
    await withRuntimeOwner(async () => {
      await recordDeferredPluginMigrations({
        pending: [{ ...pending, configPaths: [["session", "store"]] }],
      });
      await runDoctorConfigPreflight(doctorOptions);
      expect(readDeferredPluginMigrations()).toEqual([]);
    });
  });
});
