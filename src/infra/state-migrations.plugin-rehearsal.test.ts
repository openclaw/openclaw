import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  resolveLivePluginDoctorStateMigrationInventory,
} from "../plugins/doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  prepareOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";
import {
  autoMigrateLegacyPluginDoctorState,
  runPluginDoctorStateMigrationPlans,
  runPostSessionPluginDoctorStateRepairs,
} from "./state-migrations.plugin-doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "./update-runner-doctor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearPluginDoctorContractRegistryCache();
  await waitForPluginCacheRetirement();
});

it.each(["direct", "automatic", "post-session"] as const)(
  "keeps external declared plugin data untouched through the registered %s runner",
  async (runner) => {
    const root = fs.realpathSync(dirs.make("plugin-rehearsal-"));
    const stateDir = path.join(root, "copy");
    const external = path.join(root, "live.json");
    const calls = path.join(stateDir, "calls.log");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(external, "live source");
    fs.writeFileSync(calls, "");
    const outside = runner === "post-session" ? path.join(stateDir, "live-link") : external;
    if (outside !== external) {
      fs.symlinkSync(external, outside);
    }
    const env: NodeJS.ProcessEnv = {
      ...buildUpdateRehearsalPathEnv(stateDir),
      ...buildUpdateDoctorEnv({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
        serviceRepairPolicy: "external",
      }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const phase = runner === "post-session" ? "after-session-repair" : undefined;
    const paths: string[] = [];
    const resource = path.join(stateDir, "inside-data");
    for (const pluginId of ["external-owner", "inside-owner", "undeclared-owner"]) {
      const pluginRoot = path.join(stateDir, "extensions", pluginId);
      paths.push(pluginRoot);
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: {},
          doctorContract: { stateMigrations: true, configRepair: true },
        }),
      );
      const declaration =
        pluginId === "undeclared-owner"
          ? ""
          : `collectBackupResources: () => [{ path: ${JSON.stringify(pluginId === "external-owner" ? path.join(stateDir, "external-owner-data") : resource)}, kind: "file" }],`;
      const record = `fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(pluginId)} + ":" + stage + "\\n");`;
      const mutate =
        pluginId === "external-owner"
          ? `fs.writeFileSync(${JSON.stringify(external)}, "mutated live source");`
          : "";
      // The outside path is declared by a sibling in the other phase. It must
      // prevent this owner's first action from detecting or writing as well.
      const sibling =
        pluginId === "external-owner"
          ? `, {
        id: "external-sibling", label: "External sibling",
        phase: ${JSON.stringify(phase ? undefined : "after-session-repair")},
        collectBackupResources: () => [{ path: ${JSON.stringify(outside)}, kind: "file" }],
        detectLegacyState: () => detect(), migrateLegacyState: () => migrate(),
      }`
          : "";
      fs.writeFileSync(
        path.join(pluginRoot, "doctor-contract-api.cjs"),
        `
        const fs = require("node:fs");
        function record(stage) { ${record} }
        function detect() { record("detect"); return { preview: ["pending"] }; }
        function migrate() { record("migrate"); ${mutate} return { changes: ["migrated"], warnings: [] }; }
        module.exports = {
          normalizeCompatibilityConfig: ({cfg}) => ({ config: cfg, changes: [${JSON.stringify(`${pluginId} config repaired`)}] }),
          stateMigrations: [{ id: "first", label: "First", phase: ${JSON.stringify(phase)},
            ${declaration} detectLegacyState: detect, migrateLegacyState: migrate,
          }${sibling}],
        };
      `,
      );
    }
    const config: OpenClawConfig = {
      plugins: { allow: ["external-owner", "inside-owner", "undeclared-owner"], load: { paths } },
    };
    await prepareOpenClawStateDatabaseSchema({ env }, "doctor");
    recordDeferredPluginMigrations({
      env,
      pending: [
        {
          pluginId: "external-owner",
          requiresStateMigration: true,
          reason: "state import pending",
          command: "openclaw update repair",
        },
      ],
    });
    const inventory = resolveLivePluginDoctorStateMigrationInventory({ config, env });
    const run = () =>
      runner === "automatic"
        ? autoMigrateLegacyPluginDoctorState({ config, env, homedir: () => stateDir })
        : runner === "post-session"
          ? runPostSessionPluginDoctorStateRepairs({
              config,
              env,
              inventory,
              maintenanceAuthority: { assertCurrent() {} },
            })
          : runPluginDoctorStateMigrationPlans({
              config,
              env,
              inventory,
              detected: {
                stateDir,
                oauthDir: path.join(stateDir, "credentials"),
                doctorOnlyStateMigrations: true,
              },
            });

    const result = await run();
    expect(fs.readFileSync(external, "utf8")).toBe("live source");
    expect(fs.readFileSync(calls, "utf8")).not.toContain("external-owner:");
    expect(result.warnings).toEqual([]);
    expect(result.requiredPluginIds).toContain("external-owner");
    expect(result.completedPluginIds).toEqual(["inside-owner", "undeclared-owner"]);
    expect(result.notices).toEqual([
      "rehearsal: external-owner state migrations deferred; declared data outside the rehearsal root left untouched",
    ]);
    expect(readDeferredPluginMigrations({ env })).toEqual([
      expect.objectContaining({ pluginId: "external-owner", requiresStateMigration: true }),
    ]);
    expect(applyPluginDoctorCompatibilityMigrations(config, { env }).changes).toContain(
      "external-owner config repaired",
    );
    // An update marker alone is also used by live Doctor and cannot defer work.
    delete env.OPENCLAW_SKIP_CHANNELS;
    const live = await run();
    expect(fs.readFileSync(external, "utf8")).toBe("mutated live source");
    expect(live.notices ?? []).toEqual([]);
  },
);
