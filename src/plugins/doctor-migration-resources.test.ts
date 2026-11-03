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
import { writeArtifacts as writeDoctorFiles } from "./public-surface.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

let noDataMigrations: { pluginId: string; migration: PluginDoctorStateMigration }[];
let recoveryMigrations: { pluginId: string; migration: PluginDoctorStateMigration }[];
async function bundledMigrations(pluginIds: string[]) {
  const result: typeof noDataMigrations = [];
  for (const pluginId of pluginIds) {
    const { stateMigrations } = await loadBundledPluginFacade<{
      stateMigrations: PluginDoctorStateMigration[];
    }>({ pluginId, artifactBasename: "doctor-contract-api.ts" });
    result.push(...stateMigrations.map((migration) => ({ pluginId, migration })));
  }
  return result;
}
beforeAll(async () => {
  const ids = new Set([
    "crabbox-warm-profile-v3",
    "discord-legacy-state",
    "line-pre-drain-spool-rows",
    "workboard-28-kv-to-sqlite",
    "memory-core-qmd-workspace-retired",
    "memory-core-qmd-file-locks-to-sqlite-leases",
  ]);
  noDataMigrations = (
    await bundledMigrations(["crabbox", "discord", "line", "workboard", "memory-core"])
  ).filter(({ migration }) => ids.has(migration.id));
  recoveryMigrations = await bundledMigrations(["codex", "voice-call"]);
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
const resource = (name: string, kind = "sqlite") => ({ path: path.join(stateDir, name), kind });

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
    const legacy = { ...resource("legacy.sqlite"), kind: "sqlite" as const };
    const collectBackupResources = vi.fn(() => [legacy]);
    const result = await collectResources(
      { ...fixtureMigration, sqliteOnly: { family: "state" }, collectBackupResources },
      "legacy-owner",
    );
    expect(collectBackupResources).toHaveBeenCalledTimes(skipped ? 0 : 1);
    expect(result.resources).toEqual(skipped ? [] : [legacy]);
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

it.each([false, true])(
  "does not claim missing recovery coverage for bundled core-only and disposable migrations (Discord cache present: %s)",
  async (cachePresent) => {
    expect(noDataMigrations).toHaveLength(6);
    const cachePath = path.join(stateDir, "discord", "command-deploy-cache.json");
    if (cachePresent) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, '{"legacy":"cache"}');
    }
    const result = await preparePluginDoctorMigrationResources(noDataMigrations, input);
    expect(result.resources).toEqual([]);
    expect(input.warnings).toEqual([]);
    expect(fs.existsSync(cachePath)).toBe(cachePresent);
  },
);

it.each(["absent", "default", "configured"] as const)(
  "declares Codex sidecars and Voice Call SQLite recovery resources for %s state",
  async (layout) => {
    const store = path.join(stateDir, layout === "configured" ? "custom-calls" : "voice-calls");
    const database = path.join(store, "state", "openclaw.sqlite");
    const sessions = path.join(stateDir, "agents", "main", "sessions");
    const sidecar = path.join(sessions, "session.jsonl.codex-app-server.json");
    const sharedSidecar = path.join(stateDir, "sessions", "old.jsonl.codex-app-server.json");
    const sources = [database, sidecar, sharedSidecar];
    if (layout === "configured") {
      input.config = {
        plugins: { entries: { "@openclaw/voice-call": { config: { store } } } },
      };
    }
    if (layout !== "absent") {
      for (const file of sources) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "original migration input");
      }
    }
    const expected = [
      { path: path.join(stateDir, "state", "openclaw.sqlite"), kind: "sqlite" },
      ...(layout === "absent"
        ? []
        : [
            { path: database, kind: "sqlite" },
            { path: sidecar, kind: "file" },
            { path: sharedSidecar, kind: "file" },
          ]),
    ];
    for (let run = 0; run < 2; run++) {
      input.warnings = [];
      const result = await preparePluginDoctorMigrationResources(recoveryMigrations, input);
      expect(result.resources).toEqual(expected.toSorted((a, b) => a.path.localeCompare(b.path)));
      expect(input.warnings).toEqual([]);
    }
    for (const file of sources) {
      expect(fs.existsSync(file)).toBe(layout !== "absent");
      if (layout !== "absent") {
        expect(fs.readFileSync(file, "utf8")).toBe("original migration input");
      }
    }
  },
);

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
    expect(message).toMatch(
      /migration recovery coverage is unknown.*Update the plugin to a version with migration backup support\..*keep a separate backup of its configured data.*ask its maintainer to add backup support.*https:\/\/docs\.openclaw\.ai\/cli\/doctor\/state-migrations#plugin-migration-recovery-coverage/,
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
      const coerced = coercePluginDoctorContractModule({ stateMigrations: [migration] })
        .stateMigrations[0]!;
      const result = await collectResources(coerced, "planned-owner");
      expect(result.resources).toEqual([{ path: source, kind: "sqlite" }]);
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
  ["unknown kind", () => [resource("data", "unknown")]],
  [
    "conflicting kinds",
    () => [resource("data", "file"), resource("data")],
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
    writeDoctorFiles(pluginRoot, {
      "openclaw.plugin.json": {
        id: pluginId,
        configSchema: {},
        doctorContract: { stateMigrations: true },
      },
      "index.cjs": "module.exports = {};\n",
    });
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
