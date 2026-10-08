import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import {
  readDeferredPluginMigrations,
  readDeferredPluginMigrationCompletionsAsync,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createDoctorPluginMigrationPreparation } from "./doctor-config-preflight-plugin-migrations.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { prepareLegacyConfigMigrationRuntime } from "./doctor/shared/legacy-config-migrate.test-support.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const withHome = useDoctorConfigPreflightHome();
const options = {
  migrateLegacyConfig: false,
  invalidConfigNote: false,
  doctorOnlyStateMigrations: true,
  repairPrefixedConfig: true,
} as const;
let restoreRuntime: (() => void) | undefined;
beforeAll(async () => {
  restoreRuntime = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restoreRuntime?.());

async function prepareMigrationOwner() {
  const owner = createDoctorPluginMigrationPreparation({
    enabled: true,
    env: () => process.env,
    report: (result) => owner.observe(result),
    recordReceipt: () => {},
    measure: async (_name, run) => run(),
    runWithPluginMetadataSnapshot: (_scope, run) => run(),
    doctorOnlyStateMigrations: true,
  });
  const snapshot = await readConfigFileSnapshot();
  await owner.prepare(snapshot);
  await owner.converged([], snapshot, undefined);
  return owner;
}

async function readReceipt(home: string, pluginId: string) {
  const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT status, report_json FROM migration_runs WHERE id = ?")
      .get(`deferred-plugin-migration:${pluginId}`);
    return { status: row?.status, report: JSON.parse(String(row?.report_json)) };
  } finally {
    db.close();
  }
}

describe("unavailable plugin migration owners", () => {
  it.each([
    { kind: "object", value: {} },
    { kind: "array", value: [] },
  ])("keeps an authored empty legacy $kind protected", async ({ value: legacyValue }) => {
    await withHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        plugins: { enabled: false },
        legacyFixture: legacyValue,
      });
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await recordDeferredPluginMigrations({
          pending: [
            {
              pluginId: "missing-owner",
              reason: "Retained compatibility input",
              command: "openclaw doctor --fix",
              configPaths: [["legacyFixture"]],
              validationExcludedPaths: [["legacyFixture"]],
            },
          ],
        });
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        const owner = await prepareMigrationOwner();
        await owner.complete();
        expect(readDeferredPluginMigrations()).toContainEqual(
          expect.objectContaining({ pluginId: "missing-owner" }),
        );
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        expect(
          JSON.parse(await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8")),
        ).toHaveProperty("legacyFixture", legacyValue);
      });
    });
  });
  it("supersedes a replaced QQ Bot owner only after the official successor completes migration", async () => {
    await withHome(async (home) => {
      const pluginId = "openclaw-qqbot";
      const root = path.join(home, ".openclaw", "extensions", pluginId);
      const config = {
        gateway: { mode: "local" as const },
        plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
      };
      await writeOpenClawConfig(home, config);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@tencent-connect/openclaw-qqbot",
          version: "2.0.3",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(path.join(root, "index.cjs"), "module.exports = {};\n");
      await fs.writeFile(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: { type: "object" },
          doctorContract: { stateMigrations: [{ id: "retained-state" }] },
        }),
      );
      const contract = path.join(root, "doctor-contract-api.cjs");
      await fs.writeFile(
        contract,
        `module.exports = { stateMigrations: [{ id: "retained-state", label: "Retained state", detectLegacyState: () => null, migrateLegacyState: () => ({ changes: [], warnings: [] }) }] };\n`,
      );
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await seedInstalledPluginIndex(
          {
            [pluginId]: {
              source: "npm",
              spec: "@tencent-connect/openclaw-qqbot@2.0.3",
              resolvedName: "@tencent-connect/openclaw-qqbot",
              resolvedSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
              version: "2.0.3",
              installPath: root,
            },
          },
          { config },
        );
        await recordDeferredPluginMigrations({
          pending: [
            {
              pluginId: "qqbot",
              reason: "The plugin has not reported completion.",
              command: "openclaw update repair",
              requiresDoctorInspection: true,
            },
          ],
        });
        const state = createPluginStateKeyedStore<string>("qqbot", {
          namespace: "migration-fixture",
          maxEntries: 4,
        });
        await state.register("retained-input", "synthetic retained state");
        const owner = await prepareMigrationOwner();
        await owner.complete();
        expect(readDeferredPluginMigrations()).toContainEqual(
          expect.objectContaining({ pluginId: "qqbot" }),
        );
        await owner.migrate(config);
        await owner.complete();
        expect(readDeferredPluginMigrations()).not.toContainEqual(
          expect.objectContaining({ pluginId: "qqbot" }),
        );
        expect(await state.lookup("retained-input")).toBe("synthetic retained state");
        expect(await readReceipt(home, "qqbot")).toMatchObject({
          status: "superseded",
          report: { reason: expect.stringContaining('Superseded by plugin "openclaw-qqbot"') },
        });
        expect(await readDeferredPluginMigrationCompletionsAsync()).toContainEqual({
          pluginId: "qqbot",
          completedAtMs: expect.any(Number),
        });
      });
    });
  });

  it.each(["unreadable", "changed"] as const)(
    "does not settle against %s source config",
    async (kind) => {
      await withHome(async (home) => {
        const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
        await writeOpenClawConfig(home, config);
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          await recordDeferredPluginMigrations({
            pending: [
              {
                pluginId: "webhooks",
                reason: "Retained input",
                command: "openclaw doctor --fix",
                configPaths: [["plugins", "entries", "webhooks", "config"]],
              },
            ],
          });
          const configPath = path.join(home, ".openclaw", "openclaw.json");
          if (kind === "unreadable") {
            await fs.writeFile(configPath, '{ "plugins":');
          }
          const owner = await prepareMigrationOwner();
          if (kind === "changed") {
            await fs.writeFile(
              configPath,
              JSON.stringify({
                ...config,
                plugins: {
                  enabled: false,
                  entries: { webhooks: { config: { routes: ["retained"] } } },
                },
              }),
            );
            await expect(owner.complete()).rejects.toThrow("source config changed");
          } else {
            await owner.complete();
          }
          expect(readDeferredPluginMigrations()).toContainEqual(
            expect.objectContaining({ pluginId: "webhooks" }),
          );
        });
      });
    },
  );
  it("settles empty, absent, and disabled protected config across repeated Doctor and startup reads", async () => {
    await withHome(async (home) => {
      const pluginIds = ["webhooks", "absent-fixture", "disabled-fixture"];
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        plugins: {
          allow: ["other-plugin"],
          entries: { webhooks: { config: {} }, "disabled-fixture": { enabled: false, config: {} } },
        },
      });
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await recordDeferredPluginMigrations({
          pending: pluginIds.map((pluginId) => ({
            pluginId,
            reason: "The plugin has not reported completion.",
            command: "openclaw update repair",
            configPaths: [["plugins", "entries", pluginId, "config"]],
          })),
        });
        // Startup is a reader; Doctor owns settlement of this shipped pending row.
        await runStartupConfigPreflight({ gateway: true, observe: false });
        expect(readDeferredPluginMigrations()).toHaveLength(3);
        const pendingAcrossRuns = [];
        for (let run = 0; run < 2; run++) {
          const repaired = await runDoctorConfigPreflight(options);
          pendingAcrossRuns.push(readDeferredPluginMigrations());
          expect(repaired.deferredPluginMigrations).toBeUndefined();
          expect(
            repaired.stateMigrationStepReceipts?.filter(
              (receipt) =>
                pluginIds.some((id) => receipt.id === `plugin:${id}`) &&
                receipt.outcome === "deferred",
            ) ?? [],
          ).toEqual([]);
          await runStartupConfigPreflight({ gateway: true, observe: false });
          expect(readDeferredPluginMigrations()).toEqual([]);
        }
        expect(pendingAcrossRuns).toEqual([[], []]);
        for (const pluginId of pluginIds) {
          expect(await readReceipt(home, pluginId)).toMatchObject({
            status: "completed",
            report: { reason: expect.stringContaining("no protected config") },
          });
        }
      });
    });
  });

  it("keeps retained values and tells Doctor which unavailable plugin to install or enable", async () => {
    await withHome(async (home) => {
      const pluginId = "webhooks";
      const config = { routes: [{ name: "retained-route", taskFlowId: "synthetic-flow" }] };
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        plugins: { allow: ["other-plugin"], entries: { [pluginId]: { config } } },
      });
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await recordDeferredPluginMigrations({
          pending: [
            {
              pluginId,
              reason: "The plugin has not reported completion.",
              command: "openclaw update repair",
              configPaths: [["plugins", "entries", pluginId, "config"]],
            },
          ],
        });
        {
          const result = await runDoctorConfigPreflight(options);
          expect(readDeferredPluginMigrations()).toEqual([expect.objectContaining({ pluginId })]);
          expect(result.snapshot.sourceConfig.plugins?.entries?.[pluginId]?.config).toEqual(config);
          expect(result.stateMigrationStepReceipts).toContainEqual(
            expect.objectContaining({
              id: `plugin:${pluginId}`,
              outcome: "deferred",
              warnings: [expect.stringContaining('Install or enable plugin "webhooks"')],
            }),
          );
        }
        expect((await readReceipt(home, pluginId)).status).toBe("pending");
        expect(
          JSON.parse(await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"))
            .plugins.entries.webhooks.config,
        ).toEqual(config);
      });
    });
  });
});
