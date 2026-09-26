import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSessionTranscriptsHealth } from "../flows/doctor-health-contribution-runners.state.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { withDeferredPluginDoctorMigrations } from "../plugins/doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "../plugins/installed-plugin-index-records.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { assertDoctorPreflightMigrationsComplete } from "./doctor-config-preflight-migrations.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const withHome = useDoctorConfigPreflightHome();

afterEach(() => {
  clearPluginDoctorContractRegistryCache();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(["deferred-doctor", "doctor"] as const)(
  "keeps %s post-session execution bound to the admitted external plugin inventory",
  async (caller) => {
    await withHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const bundledRoot = path.join(home, "bundled");
      const externalRoot = path.join(home, "npm", "lib", "node_modules", "@openclaw");
      const actions = [
        { pluginId: "acpx", id: "acpx-session-owner-resources" },
        { pluginId: "codex", id: "codex-app-server-orphaned-session-bindings" },
      ];
      for (const root of [bundledRoot, externalRoot]) {
        for (const { pluginId, id } of actions) {
          const pluginRoot = path.join(root, pluginId);
          const source = path.join(pluginRoot, "pending-session-state");
          const target = path.join(pluginRoot, "migrated-session-state");
          const action = { id, doctorOnly: true, phase: "after-session-repair" };
          fs.mkdirSync(pluginRoot, { recursive: true });
          fs.writeFileSync(
            path.join(pluginRoot, "package.json"),
            JSON.stringify({
              name: `@openclaw/${pluginId}`,
              version: "2026.9.6",
              type: "commonjs",
              openclaw: {
                extensions: ["./index.cjs"],
                compat: { pluginApi: ">=2026.9.6" },
                build: { openclawVersion: "2026.9.6" },
              },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              configSchema: {},
              doctorContract: { stateMigrations: [action] },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "index.cjs"),
            "throw new Error('Doctor must not load plugin runtime');\n",
          );
          fs.writeFileSync(source, "retained session state");
          fs.writeFileSync(
            path.join(pluginRoot, "doctor-contract-api.cjs"),
            `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: ${JSON.stringify(pluginId)},
  detectLegacyState: () => fs.existsSync(${JSON.stringify(source)}) ? { preview: ["pending"] } : null,
  migrateLegacyState: () => {
    fs.renameSync(${JSON.stringify(source)}, ${JSON.stringify(target)});
    return { changes: [${JSON.stringify(`migrated ${pluginId}`)}], warnings: [] };
  },
}] };\n`,
          );
        }
      }
      const cfg: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: { list: [{ id: "main", default: true, workspace: path.join(home, "workspace") }] },
        plugins: {
          allow: ["acpx", "codex"],
          entries: { acpx: { enabled: true }, codex: { enabled: true } },
          load: { paths: actions.map(({ pluginId }) => path.join(externalRoot, pluginId)) },
        },
      };
      const configPath = await writeOpenClawConfig(home, cfg);
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
        async () => {
          const env = process.env;
          openOpenClawStateDatabase({ env });
          if (caller === "deferred-doctor") {
            await withPluginLifecycleLease({ env }, (lease) =>
              writePersistedInstalledPluginIndexInstallRecordsWithLease(
                Object.fromEntries(
                  actions.map(({ pluginId }) => [
                    pluginId,
                    {
                      source: "npm" as const,
                      spec: `@openclaw/${pluginId}@2026.9.6`,
                      version: "2026.9.6",
                      installPath: path.join(externalRoot, pluginId),
                    },
                  ]),
                ),
                { config: cfg, env, lease },
              ),
            );
          }
          const pending =
            caller === "deferred-doctor"
              ? [
                  {
                    pluginId: "codex",
                    reason: "Package convergence warning",
                    command: "openclaw update repair",
                    requiresStateMigration: true as const,
                  },
                ]
              : [];
          if (pending.length > 0) {
            recordDeferredPluginMigrations({ env, pending });
          }
          const admitted = caller === "deferred-doctor" ? actions.slice(0, 1) : actions;
          let receipt;
          if (caller === "doctor") {
            const ctx = await prepareDoctorContext(configPath);
            expect(ctx.cfg.agents?.entries?.main).toMatchObject({
              workspace: path.join(home, "workspace"),
            });
            expect(ctx.cfg.agents?.list).toBeUndefined();
            expect(ctx.configResult.postSessionPluginMigration?.plannedActions).toEqual(actions);
            assert.ok(ctx.runWithPluginMetadataSnapshot);
            await ctx.runWithPluginMetadataSnapshot({ config: ctx.cfg }, () =>
              runSessionTranscriptsHealth(ctx),
            );
            receipt = ctx.configResult.stateMigrationStepReceipts?.at(-1);
          } else {
            // Convergence exclusions belong to preflight's metadata scope, which ends
            // before Doctor completes the deferred session phase.
            const prepared = await withDeferredPluginDoctorMigrations(["codex"], () =>
              autoMigrateLegacyState({
                cfg,
                env,
                homedir: () => home,
                doctorOnlyStateMigrations: true,
                invocationPurpose: "doctor",
                legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
              }),
            );
            assert.ok(prepared.postSessionPluginMigration);
            expect(prepared.postSessionPluginMigration.plannedActions).toEqual([
              { pluginId: "acpx", id: "acpx-session-owner-resources" },
            ]);

            await assertDoctorPreflightMigrationsComplete({
              cfg,
              stepReceipts: prepared.stepReceipts,
              report: () => {},
            });
            await noteSessionTranscriptHealth({
              cfg,
              env,
              shouldRepair: true,
              postSessionPluginMigration: prepared.postSessionPluginMigration,
              postSessionPluginMigrationPlanBound: true,
              onStepReceipt: (step) => prepared.stepReceipts.push(step),
            });
            receipt = prepared.stepReceipts.at(-1);
          }

          expect(receipt).toMatchObject({
            id: "plugin-doctor-post-session-state",
            outcome: "completed",
            changes: admitted.map(({ pluginId }) => `migrated ${pluginId}`),
            warnings: [],
          });
          for (const { pluginId } of admitted) {
            expect(
              fs.readFileSync(path.join(externalRoot, pluginId, "migrated-session-state"), "utf8"),
            ).toBe("retained session state");
          }
          for (const pluginRoot of [
            ...(caller === "deferred-doctor" ? [path.join(externalRoot, "codex")] : []),
            path.join(bundledRoot, "acpx"),
            path.join(bundledRoot, "codex"),
          ]) {
            expect(fs.readFileSync(path.join(pluginRoot, "pending-session-state"), "utf8")).toBe(
              "retained session state",
            );
            expect(fs.existsSync(path.join(pluginRoot, "migrated-session-state"))).toBe(false);
          }
          expect(readDeferredPluginMigrations({ env })).toEqual(pending);
        },
      );
    });
  },
);
