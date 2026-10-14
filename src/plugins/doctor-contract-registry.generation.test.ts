import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  listPluginDoctorStateMigrationEntries,
  type PluginDoctorStateMigrationInventory,
} from "./doctor-contract-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("binds replaced Codex declarations and callbacks to their own package generation", async () => {
  const rootDir = dirs.make("doctor-generation-");
  const source = path.join(rootDir, "doctor-contract-api.mjs");
  const sidecars = { id: "codex-app-server-sidecars-to-plugin-state" };
  const assignments = { id: "codex-native-task-assignments" };
  const orphans = {
    id: "codex-app-server-orphaned-session-bindings",
    doctorOnly: true as const,
    phase: "after-session-repair" as const,
  };
  const before = [sidecars, orphans];
  const after = [sidecars, assignments, orphans];
  function install(version: string, actions: typeof before) {
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({ version, type: "module" }),
    );
    fs.writeFileSync(
      path.join(rootDir, "actions.mjs"),
      `export const actions = ${JSON.stringify(actions)};`,
    );
    fs.writeFileSync(
      source,
      `
      import { actions } from "./actions.mjs";
      export const stateMigrations = actions.map(action => ({
        ...action, label: action.id,
        detectLegacyState() { return { preview: [${JSON.stringify(version)}] }; },
        migrateLegacyState() { return { changes: [${JSON.stringify(version)}], warnings: [] }; },
      }));
    `,
    );
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "codex",
        configSchema: {},
        doctorContract: { stateMigrations: actions },
      }),
    );
    const loaded = loadPluginManifest(rootDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return {
      records: [
        createPluginManifestRecordFixture({
          id: "codex",
          rootDir,
          source,
          origin: "global",
          doctorContract: loaded.manifest.doctorContract,
        }),
      ],
      knownPluginIds: ["codex"],
      sessionStoreOwnerPluginIds: [],
      descriptors: [],
      unresolvedPluginIds: [],
    } satisfies PluginDoctorStateMigrationInventory;
  }
  await using previousCache = createPluginCache();
  const previousInventory = withPluginCache(previousCache, () => install("2026.9.6", before));
  const previous = withPluginCache(previousCache, () =>
    listPluginDoctorStateMigrationEntries({ inventory: previousInventory }),
  );
  await using nextCache = createPluginCache();
  const nextInventory = withPluginCache(nextCache, () => install("2026.9.7", after));
  const next = withPluginCache(nextCache, () =>
    listPluginDoctorStateMigrationEntries({ inventory: nextInventory }),
  );
  expect(next.map(({ migration }) => migration.id)).toEqual(after.map((action) => action.id));
  const input = {
    config: {},
    env: {},
    stateDir: rootDir,
    oauthDir: rootDir,
    context: {
      openPluginStateKeyedStore() {
        throw new Error("fixture must not open state");
      },
    },
  };
  expect(
    await expectDefined(previous[0], "previous migration").migration.migrateLegacyState(input),
  ).toEqual({
    changes: ["2026.9.6"],
    warnings: [],
  });
  expect(
    await expectDefined(next[0], "replacement migration").migration.migrateLegacyState(input),
  ).toEqual({
    changes: ["2026.9.7"],
    warnings: [],
  });
  for (const declaration of [
    after.toReversed(),
    [{ id: "foreign-action" }, ...after.slice(1)],
    [sidecars, assignments, { ...orphans, doctorOnly: undefined }],
    [sidecars, assignments, { ...orphans, phase: undefined }],
  ]) {
    const tampered = structuredClone(nextInventory);
    expectDefined(tampered.records[0], "replacement manifest").doctorContract = {
      stateMigrations: declaration,
    };
    expect(() =>
      withPluginCache(nextCache, () =>
        listPluginDoctorStateMigrationEntries({ inventory: tampered }),
      ),
    ).toThrow("immutable action order and authority declared by codex");
  }
});
