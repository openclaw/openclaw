import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  listPluginDoctorStateMigrationEntries,
  resolveLivePluginDoctorStateMigrationInventory,
} from "../plugins/doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../plugins/installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { loadPluginRegistrySnapshotWithMetadata } from "../plugins/plugin-registry-snapshot.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { runPostSessionPluginDoctorStateRepairs } from "./state-migrations.plugin-doctor.js";

const tempDirs = createTrackedTempDirs();
const sessionAction = { id: "session-action", phase: "after-session-repair", doctorOnly: true };

function writePlugin(params: {
  pluginRoot: string;
  pluginId: string;
  markerPath: string;
  action?: typeof sessionAction;
  declarations?: Array<{ id: string; phase?: string; doctorOnly: boolean }>;
  change?: string;
}) {
  const { pluginRoot, pluginId, markerPath, action = sessionAction } = params;
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const [filename, content] of Object.entries({
    "package.json": {
      name: `@test/${pluginId}`,
      version: "0.0.0",
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"] },
    },
    "openclaw.plugin.json": {
      id: pluginId,
      configSchema: {},
      doctorContract: { stateMigrations: params.declarations ?? [action] },
    },
  })) {
    fs.writeFileSync(path.join(pluginRoot, filename), JSON.stringify(content));
  }
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    "throw new Error('metadata discovery loaded plugin runtime');\n",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: ${JSON.stringify(pluginId)},
  detectLegacyState: () => fs.existsSync(${JSON.stringify(markerPath)}) ? null : { preview: ["pending"] },
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(markerPath)}, "migrated");
    return { changes: [${JSON.stringify(params.change ?? `migrated ${pluginId}`)}], warnings: [] };
  },
}] };\n`,
  );
}

function makeEnv(root: string) {
  return {
    ...process.env,
    HOME: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  };
}

function repairResult(requiredPluginIds: string[], changes: string[] = []) {
  return { changes, completedPluginIds: undefined, requiredPluginIds, warnings: [] };
}

function discoverActions(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return resolveLivePluginDoctorStateMigrationInventory({ config, env }).descriptors.map(
    ({ pluginId, id }) => ({ pluginId, id }),
  );
}

function repair(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  plannedActions: Array<{ pluginId: string; id: string }>,
) {
  return withDoctorSqliteMaintenanceLock({
    env,
    operation: "plugin session repair",
    run: (maintenanceAuthority) =>
      runPostSessionPluginDoctorStateRepairs({ config, env, maintenanceAuthority, plannedActions }),
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  clearPluginDoctorContractRegistryCache();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it("repairs a planned bundled owner omitted by a partial index after acquiring fresh maintenance ownership", async () => {
  const root = await tempDirs.make("openclaw-doctor-partial-inventory-");
  const bundledRoot = path.join(root, "bundled");
  const pluginIds = ["kept-owner", "omitted-owner"];
  for (const pluginId of pluginIds) {
    writePlugin({
      pluginRoot: path.join(bundledRoot, pluginId),
      pluginId,
      markerPath: path.join(root, "state", `${pluginId}-migrated`),
    });
  }
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
    plugins: { allow: ["kept-owner"] },
  };
  const env = makeEnv(root);
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const fullIndex = withPluginCache(createPluginCache(), () =>
    loadInstalledPluginIndex({ config, env }),
  );
  // Older Doctor initialization persisted a projection with otherwise current metadata.
  await writePersistedInstalledPluginIndex(
    {
      ...fullIndex,
      refreshReason: "migration",
      plugins: fullIndex.plugins.filter((plugin) => plugin.pluginId === "kept-owner"),
    },
    { env },
  );
  withPluginCache(createPluginCache(), () => {
    const cached = loadPluginRegistrySnapshotWithMetadata({ config, env });
    expect(cached.source).toBe("persisted");
    expect(cached.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["kept-owner"]);
  });
  await withPluginCache(createPluginCache(), async () => {
    const snapshot = loadPluginMetadataSnapshot({ config, env, index: fullIndex });
    return withPluginMetadataSnapshotScope(
      snapshot,
      async () => {
        const actions = discoverActions(config, env);
        expect(actions).toEqual([
          { pluginId: "kept-owner", id: "session-action" },
          { pluginId: "omitted-owner", id: "session-action" },
        ]);
        await expect(repair(config, env, actions)).resolves.toEqual(
          repairResult(pluginIds, ["migrated kept-owner", "migrated omitted-owner"]),
        );
        for (const pluginId of pluginIds) {
          const marker = path.join(root, "state", `${pluginId}-migrated`);
          expect(fs.readFileSync(marker, "utf8")).toBe("migrated");
        }
        await expect(repair(config, env, actions)).resolves.toEqual(repairResult(pluginIds));
      },
      { config, env },
    );
  });
  const persisted = withPluginCache(createPluginCache(), () =>
    readPersistedInstalledPluginIndexSync({ env }),
  );
  expect(persisted?.plugins.map((plugin) => plugin.pluginId)).toEqual(["kept-owner"]);
});

it("keeps supported discovery and execution order stable when a configured alias is removed", async () => {
  const root = await tempDirs.make("openclaw-doctor-order-discovery-");
  const bundledRoot = path.join(root, "bundled");
  const markerPath = (pluginId: string) => path.join(root, "state", `${pluginId}-migrated`);
  for (const pluginId of ["acpx", "codex"] as const) {
    writePlugin({
      pluginRoot: path.join(bundledRoot, pluginId),
      pluginId,
      markerPath: markerPath(pluginId),
      action: { ...sessionAction, id: `${pluginId}-session-action` },
    });
  }
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  const baseConfig: OpenClawConfig = {
    plugins: { entries: { acpx: { enabled: true }, codex: { enabled: true } } },
  };
  const aliasConfig: OpenClawConfig = {
    plugins: {
      ...baseConfig.plugins,
      load: { paths: [path.join(bundledRoot, "codex")] },
    },
  };
  const env = makeEnv(root);
  const frozenActions = discoverActions(aliasConfig, env);
  expect(frozenActions).toEqual([
    { pluginId: "acpx", id: "acpx-session-action" },
    { pluginId: "codex", id: "codex-session-action" },
  ]);
  expect(discoverActions(baseConfig, env)).toEqual(frozenActions);
  await expect(repair(baseConfig, env, frozenActions.toReversed())).resolves.toEqual({
    ...repairResult(["acpx", "codex"]),
    warnings: [expect.stringContaining("immutable action order")],
    warningDisposition: undefined,
  });
  await expect(repair(baseConfig, env, frozenActions)).resolves.toEqual(
    repairResult(["acpx", "codex"], ["migrated acpx", "migrated codex"]),
  );
  expect(fs.readFileSync(markerPath("acpx"), "utf8")).toBe("migrated");
  expect(fs.readFileSync(markerPath("codex"), "utf8")).toBe("migrated");
});

it.each([
  "readable",
  "staging-unavailable",
  "undeclared-post-action",
  "changed-phase",
  "changed-authority",
  "automatic-cache",
] as const)(
  "does not silently drop a live post-session action when inventory is %s",
  async (inventory) => {
    const root = await tempDirs.make("openclaw-doctor-live-inventory-");
    const pluginId = "inventory-owner";
    const pluginRoot = path.join(root, pluginId);
    const mutationPath = path.join(root, "migrated");
    const cacheRoot = path.join(root, "cache");
    const unavailableCacheRoot = path.join(root, "unavailable-cache");
    fs.mkdirSync(cacheRoot);
    if (inventory === "staging-unavailable") {
      fs.writeFileSync(unavailableCacheRoot, "not a directory");
    }
    vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
    const declaration = {
      ...sessionAction,
      phase: inventory === "changed-phase" ? undefined : sessionAction.phase,
      doctorOnly: inventory !== "changed-authority",
    };
    writePlugin({
      pluginRoot,
      pluginId,
      markerPath: mutationPath,
      change: "migrated session action",
      declarations: inventory === "undeclared-post-action" ? [] : [declaration],
    });
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: { load: { paths: [pluginRoot] }, entries: { [pluginId]: { enabled: true } } },
    };
    const env = {
      ...makeEnv(root),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      XDG_CACHE_HOME: cacheRoot,
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    clearPluginDoctorContractRegistryCache();
    if (inventory === "staging-unavailable") {
      // Invalidate an ordinary read before testing artifact-preserving discovery.
      expect(listPluginDoctorStateMigrationEntries({ config: cfg, env })).toHaveLength(1);
      clearPluginDoctorContractRegistryCache();
    }
    let stagingFaultArmed = false;
    const params: Parameters<typeof autoMigrateLegacyState>[0] = {
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: inventory !== "automatic-cache",
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      onStepReceipt(receipt) {
        if (
          inventory === "staging-unavailable" &&
          receipt.id === "config-machine-state" &&
          receipt.outcome !== "refused"
        ) {
          // Fail discovery snapshots only after prerequisite schema preparation.
          vi.stubEnv("XDG_CACHE_HOME", unavailableCacheRoot);
          env.XDG_CACHE_HOME = unavailableCacheRoot;
          stagingFaultArmed = true;
        }
      },
    };
    const result = await autoMigrateLegacyState(params);
    expect(fs.existsSync(mutationPath)).toBe(false);
    expect(stagingFaultArmed).toBe(inventory === "staging-unavailable");
    if (inventory === "automatic-cache") {
      expect(result.stepReceipts.length).toBeGreaterThan(0);
      await expect(autoMigrateLegacyState(params)).resolves.toMatchObject({
        mode: "automatic",
        skipped: true,
        changes: [],
        stepReceipts: [],
      });
      return;
    }
    if (inventory !== "readable") {
      const blocker = result.stepReceipts.findIndex((receipt) => receipt.outcome === "refused");
      // Agent history now needs the artifact-preserving snapshot before plugin inventory does.
      expect(result.stepReceipts[blocker]).toMatchObject({
        id: inventory === "staging-unavailable" ? "agent-migration-targets" : "plugin-doctor-state",
        refusal: {
          code:
            inventory === "staging-unavailable" ? "agent-target-discovery-failed" : "step-refused",
        },
      });
      const blockedReceipts = result.stepReceipts.slice(blocker + 1);
      expect(blockedReceipts).toContainEqual(
        expect.objectContaining({ id: "plugin-doctor-post-session-state" }),
      );
      for (const receipt of blockedReceipts) {
        expect(receipt).toMatchObject({
          outcome: "refused",
          refusal: { code: "blocked-by-prior-refusal" },
        });
      }
      expect(result.postSessionPluginMigration).toBeUndefined();
      if (inventory === "undeclared-post-action") {
        const repeated = await autoMigrateLegacyState(params);
        expect(repeated.stepReceipts.map((r) => [r.id, r.outcome, r.refusal])).toEqual(
          result.stepReceipts.map((r) => [r.id, r.outcome, r.refusal]),
        );
      }
      return;
    }
    expect(result.warnings).toEqual([]);
    // A later Doctor invocation must still plan the unconsumed handoff from live state.
    const repeated = await autoMigrateLegacyState(params);
    expect(repeated.postSessionPluginMigration).toEqual(result.postSessionPluginMigration);
    expect(repeated.stepReceipts.length).toBeGreaterThan(0);
    const prepared = repeated.postSessionPluginMigration;
    expect(prepared?.step).toMatchObject({
      source: [{ kind: "owner", id: `plugin:${pluginId}:session-action` }],
      target: [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }],
      requiredness: "conditional",
    });
    await expect(
      runPostSessionPluginDoctorStateRepairs({
        config: cfg,
        env,
        maintenanceAuthority: { assertCurrent() {} },
        plannedActions: prepared?.plannedActions,
      }),
    ).resolves.toEqual(repairResult(["inventory-owner"], ["migrated session action"]));
    expect(fs.readFileSync(mutationPath, "utf8")).toBe("migrated");
  },
);
