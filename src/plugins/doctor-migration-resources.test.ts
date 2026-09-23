import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { definePluginDoctorMigrationFromPlans } from "../plugin-sdk/doctor-migration-plan-adapter.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { coercePluginDoctorContractModule } from "./doctor-contract-module.js";
import type { PluginDoctorStateMigration } from "./doctor-contract-module.js";
import { collectPluginDoctorMigrationBackupResources } from "./doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "./doctor-contract-registry.test-fixtures.js";
import { collectPluginDoctorMigrationResources } from "./doctor-migration-resources.js";
import { waitForPluginCacheRetirement } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

let canvasMigrations: PluginDoctorStateMigration[];
beforeAll(async () => {
  ({ stateMigrations: canvasMigrations } = await loadBundledPluginFacade<{
    stateMigrations: PluginDoctorStateMigration[];
  }>({ pluginId: "canvas", artifactBasename: "doctor-contract-api.ts" }));
});

const tempDirs: string[] = [];
let stateDir: string;
beforeEach(() => {
  stateDir = makeTrackedTempDir("openclaw-migration-resource-warning", tempDirs);
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

function params() {
  return {
    config: {},
    env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir },
    stateDir,
    requireLocalResources: true,
    warnings: [] as Array<{
      kind: "undeclared-migration-resources";
      pluginId: string;
      message: string;
    }>,
  };
}

it("admits the actual bundled Canvas legacy migration with an honest recovery-set warning", async () => {
  const migration = canvasMigrations.find(
    (entry) => entry.id === "canvas-custom-root-documents-to-core",
  );
  if (!migration) {
    throw new Error("Missing shipped Canvas migration");
  }
  expect(migration.collectBackupResources).toBeUndefined();
  const detect = vi.spyOn(migration, "detectLegacyState");
  const migrate = vi.spyOn(migration, "migrateLegacyState");
  const input = params();
  await expect(
    collectPluginDoctorMigrationResources([{ pluginId: "canvas", migration }], input),
  ).resolves.toEqual([]);
  expect(input.warnings).toEqual([
    {
      kind: "undeclared-migration-resources",
      pluginId: "canvas",
      message:
        "canvas migration declares no data resources; its private state is not in the recovery set",
    },
  ]);
  expect(detect).not.toHaveBeenCalled();
  expect(migrate).not.toHaveBeenCalled();
});

it("records one warning per undeclared owner while preserving separate owners", async () => {
  const migration = canvasMigrations[0]!;
  const input = params();
  await collectPluginDoctorMigrationResources(
    [
      { pluginId: "canvas", migration },
      { pluginId: "canvas", migration: { ...migration, id: "second-action" } },
      { pluginId: "other-owner", migration },
    ],
    input,
  );
  expect(input.warnings.map((warning) => warning.pluginId)).toEqual(["canvas", "other-owner"]);
});

it("keeps declared resources and forwards strict locality without running the migration", async () => {
  const input = params();
  const source = path.join(stateDir, "declared.sqlite");
  const collect = vi.fn<NonNullable<PluginDoctorStateMigration["collectBackupResources"]>>(() => [
    { path: source, kind: "sqlite" as const },
  ]);
  const migrate = vi.fn();
  const migration = {
    ...canvasMigrations[0]!,
    collectBackupResources: collect,
    migrateLegacyState: migrate,
  };
  await expect(
    collectPluginDoctorMigrationResources([{ pluginId: "declared-owner", migration }], input),
  ).resolves.toEqual([{ path: source, kind: "sqlite" }]);
  expect(collect).toHaveBeenCalledOnce();
  expect(collect.mock.calls[0]?.[0].requireLocalResources).toBe(true);
  expect(collect.mock.calls[0]?.[0].stateDir).toBe(stateDir);
  expect(input.warnings).toEqual([]);
  expect(migrate).not.toHaveBeenCalled();
});

it("preserves a declared inventory through the SDK plan adapter and contract coercion", async () => {
  const input = params();
  const source = path.join(stateDir, "planned.sqlite");
  const collectBackupResources = vi.fn(() => [{ path: source, kind: "sqlite" as const }]);
  const resolvePlans = vi.fn(() => []);
  const declaration = {
    id: "planned-migration",
    label: "Planned migration",
    resolvePlans,
    collectBackupResources,
  };
  const migration = definePluginDoctorMigrationFromPlans(declaration);
  const contract = coercePluginDoctorContractModule({ stateMigrations: [migration] });
  const coerced = contract?.stateMigrations?.[0];
  if (!coerced) {
    throw new Error("Missing adapted migration");
  }
  await expect(
    collectPluginDoctorMigrationResources(
      [{ pluginId: "planned-owner", migration: coerced }],
      input,
    ),
  ).resolves.toEqual([{ path: source, kind: "sqlite" }]);
  expect(collectBackupResources).toHaveBeenCalledOnce();
  expect(collectBackupResources).toHaveBeenCalledWith(
    expect.objectContaining({ stateDir, requireLocalResources: true }),
  );
  expect(resolvePlans).not.toHaveBeenCalled();
  expect(input.warnings).toEqual([]);
});

it("does not downgrade a malformed adapter declaration to an undeclared warning", async () => {
  const input = params();
  const resolvePlans = vi.fn(() => []);
  const migration = definePluginDoctorMigrationFromPlans({
    id: "invalid-adapter",
    label: "Invalid adapter",
    resolvePlans,
    collectBackupResources: null as unknown as NonNullable<
      PluginDoctorStateMigration["collectBackupResources"]
    >,
  });
  await expect(
    collectPluginDoctorMigrationResources([{ pluginId: "invalid-owner", migration }], input),
  ).rejects.toThrow("collectBackupResources");
  expect(resolvePlans).not.toHaveBeenCalled();
  expect(input.warnings).toEqual([]);
});

it.each([
  ["non-array inventory", () => ({}), "Invalid migration backup inventory"],
  [
    "relative path",
    () => [{ path: "relative.sqlite", kind: "sqlite" }],
    "Invalid migration backup resource",
  ],
  [
    "parent traversal before normalization",
    () => [
      { path: `${stateDir}${path.sep}linked${path.sep}..${path.sep}data.sqlite`, kind: "sqlite" },
    ],
    "Invalid migration backup resource",
  ],
  [
    "unknown kind",
    () => [{ path: path.join(stateDir, "data"), kind: "unknown" }],
    "Invalid migration backup resource",
  ],
  [
    "conflicting kinds",
    () => [
      { path: path.join(stateDir, "data"), kind: "file" },
      { path: path.join(stateDir, "data"), kind: "sqlite" },
    ],
    "Conflicting migration backup resource kinds",
  ],
] as const)("still refuses a declared %s", async (_label, collect, message) => {
  const input = params();
  const migration = {
    ...canvasMigrations[0]!,
    collectBackupResources: collect as PluginDoctorStateMigration["collectBackupResources"],
  };
  await expect(
    collectPluginDoctorMigrationResources([{ pluginId: "invalid-owner", migration }], input),
  ).rejects.toThrow(message);
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
    const input = params();
    const result = collectPluginDoctorMigrationBackupResources({
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
      await expect(result).resolves.toEqual([{ path: resourcePath, kind: "sqlite" }]);
      expect(input.warnings).toEqual([]);
    } else {
      await expect(result).resolves.toEqual([]);
      expect(input.warnings).toEqual([
        expect.objectContaining({ kind: "undeclared-migration-resources", pluginId }),
      ]);
    }
  },
);
