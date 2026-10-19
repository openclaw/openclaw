import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { definePluginDoctorMigrationFromPlans } from "../plugin-sdk/doctor-migration-plan-adapter.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";
import type { PluginDoctorStateMigration } from "./doctor-contract-module.js";
import { preparePluginDoctorMigrationBackupResources } from "./doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import {
  type PluginDoctorMigrationResourceCollectionParams,
  preparePluginDoctorMigrationResources,
} from "./doctor-migration-resources.js";
import { waitForPluginCacheRetirement } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

let noDataMigrations: { pluginId: string; migration: PluginDoctorStateMigration }[];
beforeAll(async () => {
  const ids = new Set([
    "crabbox-warm-profile-v3",
    "workboard-28-kv-to-sqlite",
    "memory-core-qmd-workspace-retired",
    "memory-core-qmd-file-locks-to-sqlite-leases",
  ]);
  noDataMigrations = [];
  for (const pluginId of ["crabbox", "workboard", "memory-core"]) {
    const { stateMigrations } = await loadBundledPluginFacade<{
      stateMigrations: PluginDoctorStateMigration[];
    }>({ pluginId, artifactBasename: "doctor-contract-api.ts" });
    noDataMigrations.push(
      ...stateMigrations
        .filter((migration) => ids.has(migration.id))
        .map((migration) => ({ pluginId, migration })),
    );
  }
});

const tempDirs: string[] = [];
let stateDir: string;
let input: PluginDoctorMigrationResourceCollectionParams;
let fixtureMigration: PluginDoctorStateMigration;
beforeEach(() => {
  stateDir = makeTrackedTempDir("openclaw-migration-resource-warning", tempDirs);
  input = {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir },
    stateDir,
    requireLocalResources: true,
    warnings: [],
  };
  fixtureMigration = {
    id: "resource-fixture",
    label: "Resource fixture",
    detectLegacyState: vi.fn(() => null),
    migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
  };
});
afterEach(async () => {
  try {
    vi.restoreAllMocks();
    clearPluginDoctorContractRegistryCache();
    await waitForPluginCacheRetirement();
  } finally {
    cleanupTrackedTempDirs(tempDirs);
  }
});

function collectResources(migration: PluginDoctorStateMigration, pluginId: string) {
  return preparePluginDoctorMigrationResources([{ pluginId, migration }], input);
}

it.each([
  { engine: "postgres", stateEngine: undefined, skipped: true },
  { engine: "postgres", stateEngine: "sqlite", skipped: false },
  { engine: "sqlite", stateEngine: "postgres", skipped: true },
] as const)(
  "does not inspect legacy backup paths when the effective family is PostgreSQL: $engine / $stateEngine",
  async ({ engine, stateEngine, skipped }) => {
    input.config = {
      database: {
        engine,
        ...(stateEngine ? { families: { state: { engine: stateEngine } } } : {}),
      },
    };
    const resource = { path: path.join(stateDir, "legacy.sqlite"), kind: "sqlite" as const };
    const collectBackupResources = vi.fn(() => [resource]);
    const result = await collectResources(
      { ...fixtureMigration, sqliteOnly: { family: "state" }, collectBackupResources },
      "legacy-owner",
    );
    expect(collectBackupResources).toHaveBeenCalledTimes(skipped ? 0 : 1);
    expect(result.resources).toEqual(skipped ? [] : [resource]);
    expect(result.notices).toEqual(
      skipped
        ? [
            "Resource fixture: legacy SQLite migration not applicable on PostgreSQL; legacy data is migrated before port.",
          ]
        : [],
    );
    expect(input.warnings).toEqual([]);
  },
);

it("does not claim missing recovery coverage for bundled core-only and disposable migrations", async () => {
  expect(noDataMigrations).toHaveLength(4);
  const result = await preparePluginDoctorMigrationResources(noDataMigrations, input);
  expect(result.resources).toEqual([]);
  expect(input.warnings).toEqual([]);
});

it("warns once per undeclared owner without running its migration", async () => {
  const result = await preparePluginDoctorMigrationResources(
    [
      { pluginId: "canvas", migration: fixtureMigration },
      { pluginId: "canvas", migration: { ...fixtureMigration, id: "second-action" } },
      { pluginId: "other-owner", migration: fixtureMigration },
    ],
    input,
  );
  expect(result.resources).toEqual([]);
  expect(input.warnings).toEqual([
    expect.objectContaining({ kind: "undeclared-migration-resources", pluginId: "canvas" }),
    expect.objectContaining({ kind: "undeclared-migration-resources", pluginId: "other-owner" }),
  ]);
  for (const { message } of input.warnings) {
    expect(message).toContain("migration recovery coverage is unknown");
    expect(message).toContain("Update the plugin to a version with migration backup support.");
    expect(message).toContain("keep a separate backup of its configured data");
    expect(message).toContain("ask its maintainer to add backup support");
    expect(message).toContain(
      "https://docs.openclaw.ai/cli/doctor/state-migrations#plugin-migration-recovery-coverage",
    );
  }
  expect(fixtureMigration.detectLegacyState).not.toHaveBeenCalled();
  expect(fixtureMigration.migrateLegacyState).not.toHaveBeenCalled();
});

it.each(["declared", "malformed"] as const)(
  "preserves the SDK adapter's %s inventory without resolving migration plans",
  async (declaration) => {
    const source = path.join(stateDir, "planned.sqlite");
    const collectBackupResources = vi.fn(() => [{ path: source, kind: "sqlite" as const }]);
    const resolvePlans = vi.fn(() => []);
    const migration = definePluginDoctorMigrationFromPlans({
      id: "planned-migration",
      label: "Planned migration",
      resolvePlans,
      collectBackupResources:
        declaration === "declared"
          ? collectBackupResources
          : (null as unknown as NonNullable<PluginDoctorStateMigration["collectBackupResources"]>),
    });
    if (declaration === "malformed") {
      await expect(collectResources(migration, "planned-owner")).rejects.toThrow(
        "collectBackupResources",
      );
    } else {
      const contract = coercePluginDoctorContractModule({ stateMigrations: [migration] });
      const coerced = contract?.stateMigrations?.[0];
      if (!coerced) {
        throw new Error("Missing adapted migration");
      }
      const result = await collectResources(coerced, "planned-owner");
      expect(result.resources).toEqual([{ path: source, kind: "sqlite" }]);
      expect(collectBackupResources).toHaveBeenCalledOnce();
      expect(collectBackupResources).toHaveBeenCalledWith(
        expect.objectContaining({ stateDir, requireLocalResources: true }),
      );
    }
    expect(resolvePlans).not.toHaveBeenCalled();
    expect(input.warnings).toEqual([]);
  },
);

it.each([
  ["non-array inventory", () => ({}), "Invalid migration backup inventory"],
  ["relative path", () => [{ path: "relative.sqlite", kind: "sqlite" }]],
  [
    "parent traversal before normalization",
    () => [
      { path: `${stateDir}${path.sep}linked${path.sep}..${path.sep}data.sqlite`, kind: "sqlite" },
    ],
  ],
  ["unknown kind", () => [{ path: path.join(stateDir, "data"), kind: "unknown" }]],
  [
    "conflicting kinds",
    () => [
      { path: path.join(stateDir, "data"), kind: "file" },
      { path: path.join(stateDir, "data"), kind: "sqlite" },
    ],
    "Conflicting migration backup resource kinds",
  ],
] as const)("still refuses a declared %s", async (_label, collect, message?: string) => {
  const invalid = {
    ...fixtureMigration,
    collectBackupResources: collect as PluginDoctorStateMigration["collectBackupResources"],
  };
  await expect(collectResources(invalid, "invalid-owner")).rejects.toThrow(
    message ?? "Invalid migration backup resource",
  );
  expect(input.warnings).toEqual([]);
});

it.each(["undeclared", "declared", "malformed"] as const)(
  "collects a configured plugin's %s inventory through the registry without migrating",
  async (declaration) => {
    const pluginId = "warning-fixture";
    const pluginRoot = path.join(stateDir, "plugin");
    const resourcePath = path.join(stateDir, "private.sqlite");
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: {},
        doctorContract: { stateMigrations: true },
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
    const inventory =
      declaration === "undeclared"
        ? ""
        : declaration === "malformed"
          ? "collectBackupResources: null,"
          : `collectBackupResources: () => [{ path: ${JSON.stringify(resourcePath)}, kind: "sqlite" }],`;
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `module.exports = {
      stateMigrations: [{ id: "private-state", label: "Private state", ${inventory}
        detectLegacyState() { throw new Error("must not detect during inventory"); },
        migrateLegacyState() { throw new Error("must not migrate during inventory"); },
      }],
    };`,
    );
    const result = preparePluginDoctorMigrationBackupResources({
      ...input,
      config: {
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginRoot] },
          entries: { [pluginId]: { enabled: true } },
        },
      },
      env: { ...input.env, HOME: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    if (declaration === "malformed") {
      await expect(result).rejects.toThrow("collectBackupResources");
      expect(input.warnings).toEqual([]);
    } else if (declaration === "declared") {
      expect((await result).resources).toEqual([{ path: resourcePath, kind: "sqlite" }]);
      expect(input.warnings).toEqual([]);
    } else {
      expect((await result).resources).toEqual([]);
      expect(input.warnings).toEqual([
        expect.objectContaining({ kind: "undeclared-migration-resources", pluginId }),
      ]);
    }
  },
);
