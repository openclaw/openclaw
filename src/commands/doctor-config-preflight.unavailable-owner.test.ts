import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfigFileSnapshot } from "../config/io.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createDoctorPluginMigrationPreparation } from "./doctor-config-preflight-plugin-migrations.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { prepareLegacyConfigMigrationRuntime } from "./doctor/shared/legacy-config-migrate.test-support.js";
import { inspectPluginMigrationAvailability } from "./doctor/shared/plugin-migration-availability.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

const isolatedHome = useDoctorConfigPreflightHome();
const withHome = (run: (home: string) => Promise<void>) =>
  isolatedHome((home) => withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => run(home)));
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

const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
const readConfig = async (home: string) =>
  JSON.parse(await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
async function installFixture(
  home: string,
  id: string,
  name: string,
  version: string,
  stateMigrations = false,
) {
  const root = path.join(home, ".openclaw", "extensions", id.toLowerCase());
  await fs.mkdir(root, { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name,
    version,
    openclaw: { extensions: ["./index.cjs"] },
  });
  await fs.writeFile(
    path.join(root, "index.cjs"),
    stateMigrations
      ? "module.exports = {};\n"
      : `module.exports = { id: "${id}", register() {} };\n`,
  );
  await writeJson(path.join(root, "openclaw.plugin.json"), {
    id,
    configSchema: { type: "object" },
    ...(stateMigrations ? { doctorContract: { stateMigrations: [{ id: "retained-state" }] } } : {}),
  });
  return {
    source: "npm" as const,
    spec: `${name}@${version}`,
    resolvedName: name,
    resolvedSpec: `${name}@${version}`,
    version,
    installPath: root,
  };
}
function makePending(pluginId: string, overrides: Partial<DeferredPluginMigration> = {}) {
  return {
    pluginId,
    reason: "The plugin has not reported completion.",
    command: "openclaw update repair",
    ...overrides,
  };
}
const protectedConfig = (pluginId: string) => [["plugins", "entries", pluginId, "config"]];
const hasPending = (pluginId: string) => expect.objectContaining({ pluginId });
const defer = (...pending: DeferredPluginMigration[]) =>
  recordDeferredPluginMigrations({ pending });

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
  const snapshot = await readConfigFileSnapshot(await owner.snapshotOptions());
  await owner.prepare(snapshot);
  await owner.converged([], snapshot, undefined);
  return owner;
}

async function readReceipt(home: string, pluginId: string) {
  const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  const { DatabaseSync } = requireNodeSqlite();
  using db = new DatabaseSync(databasePath, { readOnly: true });
  const row = db
    .prepare("SELECT status, report_json FROM migration_runs WHERE id = ?")
    .get(`deferred-plugin-migration:${pluginId}`);
  return { status: row?.status, report: JSON.parse(String(row?.report_json)) };
}

describe("unavailable plugin migration owners", () => {
  it("recognizes an installed mixed-case owner and settles its earlier canonical obligation", async () => {
    await withHome(async (home) => {
      const pluginId = "MiXeD-upgrade-proof";
      const policyId = "mixed-upgrade-proof";
      const config = {
        gateway: { mode: "local" as const },
        plugins: { entries: { [policyId]: { enabled: true } } },
      };
      await writeOpenClawConfig(home, config);
      const record = await installFixture(home, pluginId, "@fixture/mixed-upgrade-proof", "1.0.0");
      await seedInstalledPluginIndex({ [pluginId]: record }, { config });
      const available = await inspectPluginMigrationAvailability({
        cfg: config,
        env: process.env,
        deferInstallation: false,
      });
      expect(available.pending).toEqual([]);
      expect(available.statelessPlugins).toContainEqual({ id: pluginId, version: "1.0.0" });
      expect(available.unavailablePluginIds).not.toContain(pluginId);
      for (const plugins of [
        { ...config.plugins, deny: [policyId] },
        { ...config.plugins, entries: { [policyId]: { enabled: false } } },
      ]) {
        const blocked = await inspectPluginMigrationAvailability({
          cfg: { ...config, plugins },
          env: process.env,
          retainedPluginIds: [policyId],
          deferInstallation: false,
        });
        expect(blocked.statelessPlugins).toEqual([]);
        expect(blocked.unavailablePluginIds).toContain(pluginId);
      }

      await defer(makePending(policyId, { requiresStateMigration: true }));
      const owner = await prepareMigrationOwner();
      await owner.complete();
      expect(readDeferredPluginMigrations()).toContainEqual(
        expect.objectContaining({ pluginId: policyId, requiresStateMigration: true }),
      );
      owner.observe({ changes: [], warnings: [], completedPluginIds: [pluginId] });
      await owner.complete();
      expect(readDeferredPluginMigrations()).toEqual([]);
      expect(await readReceipt(home, policyId)).toMatchObject({ status: "completed" });
    });
  });

  it.each([
    { kind: "object", value: {} },
    { kind: "array", value: [] },
  ])(
    "keeps an authored empty legacy $kind protected during Doctor preparation",
    async ({ value: legacyValue }) => {
      await withHome(async (home) => {
        await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          plugins: { enabled: false },
          legacyFixture: legacyValue,
        });
        await defer(
          makePending("missing-owner", {
            configPaths: [["legacyFixture"]],
            validationExcludedPaths: [["legacyFixture"]],
          }),
        );
        expect((await readConfigFileSnapshot()).valid).toBe(false);
        const owner = await prepareMigrationOwner();
        await owner.complete();
        expect(readDeferredPluginMigrations()).toContainEqual(hasPending("missing-owner"));
        expect((await readConfigFileSnapshot(await owner.snapshotOptions())).valid).toBe(true);
        expect(await readConfig(home)).toHaveProperty("legacyFixture", legacyValue);
      });
    },
  );
  it("supersedes a replaced QQ Bot owner only after the official successor completes migration", async () => {
    await withHome(async (home) => {
      const pluginId = "openclaw-qqbot";
      const config = {
        gateway: { mode: "local" as const },
        plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
      };
      await writeOpenClawConfig(home, config);
      const record = await installFixture(
        home,
        pluginId,
        "@tencent-connect/openclaw-qqbot",
        "2.0.3",
        true,
      );
      const contract = path.join(record.installPath, "doctor-contract-api.cjs");
      await fs.writeFile(
        contract,
        `module.exports = { stateMigrations: [{ id: "retained-state", label: "Retained state", detectLegacyState: () => null, migrateLegacyState: () => ({ changes: [], warnings: [] }) }] };\n`,
      );
      await seedInstalledPluginIndex({ [pluginId]: record }, { config });
      await defer(makePending("qqbot", { requiresDoctorInspection: true }));
      const state = createPluginStateKeyedStore<string>("qqbot", {
        namespace: "migration-fixture",
        maxEntries: 4,
      });
      await state.register("retained-input", "synthetic retained state");
      const owner = await prepareMigrationOwner();
      await owner.complete();
      expect(readDeferredPluginMigrations()).toContainEqual(hasPending("qqbot"));
      await owner.migrate(config);
      await owner.complete();
      expect(readDeferredPluginMigrations()).not.toContainEqual(hasPending("qqbot"));
      expect(await state.lookup("retained-input")).toBe("synthetic retained state");
      expect(await readReceipt(home, "qqbot")).toMatchObject({
        status: "superseded",
        report: { reason: expect.stringContaining('Superseded by plugin "openclaw-qqbot"') },
      });
      expect(
        await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
          type: "plugins.deferredMigrations.completions.read",
          input: undefined,
        }),
      ).toContainEqual({
        pluginId: "qqbot",
        completedAtMs: expect.any(Number),
      });
    });
  });

  it.each(["unreadable", "changed"] as const)(
    "does not settle against %s source config",
    async (kind) => {
      await withHome(async (home) => {
        const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
        await writeOpenClawConfig(home, config);
        await defer(makePending("webhooks", { configPaths: protectedConfig("webhooks") }));
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        if (kind === "unreadable") {
          await fs.writeFile(configPath, '{ "plugins":');
        }
        const owner = await prepareMigrationOwner();
        if (kind === "changed") {
          await writeJson(configPath, {
            ...config,
            plugins: {
              enabled: false,
              entries: { webhooks: { config: { routes: ["retained"] } } },
            },
          });
          await expect(owner.complete()).rejects.toThrow("source config changed");
        } else {
          await owner.complete();
        }
        expect(readDeferredPluginMigrations()).toContainEqual(hasPending("webhooks"));
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
      await defer(...pluginIds.map((id) => makePending(id, { configPaths: protectedConfig(id) })));
      // Startup is a reader; Doctor owns settlement of this shipped pending row.
      await runStartupConfigPreflight({ gateway: true, observe: false });
      expect(readDeferredPluginMigrations()).toHaveLength(3);
      for (let run = 0; run < 2; run++) {
        const repaired = await runDoctorConfigPreflight(options);
        expect(readDeferredPluginMigrations()).toEqual([]);
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
      for (const pluginId of pluginIds) {
        expect(await readReceipt(home, pluginId)).toMatchObject({
          status: "completed",
          report: { reason: expect.stringContaining("no protected config") },
        });
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "retains the blocked-path diagnosis after Doctor settles migration receipts",
    async () => {
      await withHome(async (home) => {
        const pluginId = "blocked-owner-fixture";
        const pluginPath = path.join(home, "local-plugin");
        await fs.mkdir(pluginPath);
        await writeJson(path.join(pluginPath, "openclaw.plugin.json"), {
          id: pluginId,
          configSchema: { type: "object" },
        });
        await fs.writeFile(
          path.join(pluginPath, "index.js"),
          "throw new Error('must not execute');\n",
        );
        await fs.chmod(pluginPath, 0o777);
        try {
          await writeOpenClawConfig(home, {
            gateway: { mode: "local" },
            plugins: {
              load: { paths: [pluginPath] },
              entries: { [pluginId]: { enabled: true, config: { retained: "authored" } } },
            },
          });
          const result = await runDoctorConfigPreflight(options);
          const pending = readDeferredPluginMigrations().find(
            (entry) => entry.pluginId === pluginId,
          );
          expect(pending).toMatchObject({
            reason: expect.stringContaining("present but blocked"),
            command: "openclaw doctor --fix",
          });
          expect(pending?.reason).not.toContain("Install or enable");
          expect(result.snapshot.sourceConfig.plugins?.entries?.[pluginId]).toEqual({
            enabled: true,
            config: { retained: "authored" },
          });
          expect(result.stateMigrationStepReceipts).toContainEqual(
            expect.objectContaining({
              id: "plugin:blocked-owner-fixture",
              outcome: "deferred",
              warnings: [expect.stringContaining("present but blocked")],
            }),
          );
        } finally {
          await fs.chmod(pluginPath, 0o755);
        }
      });
    },
  );

  it("keeps retained values and tells Doctor which unavailable plugin to install or enable", async () => {
    await withHome(async (home) => {
      const pluginId = "webhooks";
      const config = { routes: [{ name: "retained-route", taskFlowId: "synthetic-flow" }] };
      await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        plugins: { allow: ["other-plugin"], entries: { [pluginId]: { config } } },
      });
      await defer(makePending(pluginId, { configPaths: protectedConfig(pluginId) }));
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
      expect((await readConfig(home)).plugins.entries.webhooks.config).toEqual(config);
    });
  });
});
