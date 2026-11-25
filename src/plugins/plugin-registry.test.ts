import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { freezeTrustedJsonSnapshot } from "../shared/immutable-data.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import {
  makePluginMetadataIndex,
  makePluginMetadataManifestRegistry,
} from "./current-plugin-metadata.test-support.js";
import type { PluginCandidate } from "./discovery.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { loadPluginLookUpTable } from "./plugin-lookup-table.js";
import * as manifestIdNormalizer from "./plugin-manifest-id-normalizer.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createPluginRegistryIdNormalizer,
  listPluginContributionIds,
  loadPluginRegistrySnapshot,
  loadPluginRegistrySnapshotWithMetadata,
  normalizePluginsConfigWithRegistry,
  resolvePluginContributionOwners,
} from "./plugin-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

beforeEach(clearPluginMetadataLifecycleCaches);

afterEach(async () => {
  clearPluginMetadataLifecycleCaches();
  await closeStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry", tempDirs);
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: overrides.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim()
      ? undefined
      : "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createCandidate(
  rootDir: string,
  pluginId = "demo",
  installOwner?: string,
  manifestOverrides: Record<string, unknown> = {},
): PluginCandidate {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading plugin registry');\n",
    "utf8",
  );
  writeJson(path.join(rootDir, "openclaw.plugin.json"), {
    id: pluginId,
    name: pluginId,
    configSchema: { type: "object" },
    providers: [pluginId],
    ...manifestOverrides,
  });
  return recordPluginCandidateInstallOwner(
    { idHint: pluginId, source: path.join(rootDir, "index.ts"), rootDir, origin: "global" },
    installOwner,
  );
}

function createIndex(
  pluginId = "demo",
  overrides: Partial<InstalledPluginIndex> = {},
  record: Partial<InstalledPluginIndex["plugins"][number]> = {},
): InstalledPluginIndex {
  const index = makePluginMetadataIndex(pluginId);
  const plugin = Object.assign(expectDefined(index.plugins[0], "fixture plugin"), record);
  if (record.rootDir) {
    plugin.manifestPath = path.join(record.rootDir, "openclaw.plugin.json");
    plugin.source = path.join(record.rootDir, "index.ts");
  }
  return Object.assign(index, {
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    policyHash: "policy-v1",
    ...overrides,
  });
}

function candidateFixture(
  options: Omit<NonNullable<Parameters<typeof loadPluginRegistrySnapshot>[0]>, "candidates"> = {},
) {
  const stateDir = makeTempDir();
  const rootDir = makeTempDir();
  const candidate = createCandidate(rootDir);
  const params = { stateDir, env: hermeticEnv(), ...options, candidates: [candidate] };
  const derive = () => deriveRegistry(candidate, { env: params.env, ...options });
  return {
    ...params,
    rootDir,
    candidate,
    derive,
    persist: (index = derive()) => writePersistedInstalledPluginIndex(index, { stateDir }),
    load: (overrides: Partial<typeof params> = {}) =>
      loadPluginRegistrySnapshotWithMetadata({ ...params, ...overrides }),
  };
}

function profileFixture(pluginId = "demo") {
  const stateDir = makeTempDir();
  const configDir = makeTempDir();
  const extensionsDir = path.join(configDir, "extensions");
  const addPlugin = (id: string) => {
    const root = path.join(extensionsDir, id);
    fs.mkdirSync(root, { recursive: true });
    createCandidate(root, id);
    return root;
  };
  const pluginRoot = addPlugin(pluginId);
  const env = hermeticEnv({ OPENCLAW_CONFIG_PATH: path.join(configDir, "openclaw.json") });
  const load = (config?: OpenClawConfig) =>
    loadPluginRegistrySnapshotWithMetadata({ stateDir, env, config });
  return {
    env,
    extensionsDir,
    pluginRoot,
    addPlugin,
    load,
    persist: async (config?: OpenClawConfig) => {
      const result = load(config);
      await writePersistedInstalledPluginIndex(result.snapshot, { stateDir });
      clearPluginMetadataLifecycleCaches();
      return result;
    },
  };
}

function deriveRegistry(
  candidate: PluginCandidate,
  options: Omit<NonNullable<Parameters<typeof loadPluginRegistrySnapshot>[0]>, "candidates"> = {},
) {
  return loadPluginRegistrySnapshot({
    env: hermeticEnv(),
    preferPersisted: false,
    ...options,
    candidates: [candidate],
  });
}

function expectStale(
  result: ReturnType<typeof loadPluginRegistrySnapshotWithMetadata>,
  code = "persisted-registry-stale-source",
) {
  expect(result.source).toBe("derived");
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
}

function expectSnapshotPluginIds(snapshot: InstalledPluginIndex, expectedPluginIds: string[]) {
  expect(snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(expectedPluginIds);
}

describe("plugin registry facade", () => {
  it("keeps missing disabled records inspectable from the persisted registry", async () => {
    const config = { plugins: { entries: { demo: { enabled: false } } } };
    const fixture = candidateFixture({ config });
    await fixture.persist();
    fs.rmSync(fixture.rootDir, { recursive: true });
    const result = fixture.load({ candidates: undefined });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins.find((plugin) => plugin.pluginId === "demo")).toMatchObject({
      pluginId: "demo",
      enabled: false,
    });
  });

  it("preserves raw declarations and indexed owners without rereading manifests", () => {
    const rootDir = makeTempDir();
    const candidate = createCandidate(rootDir, "demo", undefined, {
      providers: [" Demo "],
      cliBackends: [" DEMO-CLI ", "DEMO-CLI"],
      setup: { providers: [{ id: "demo-setup" }], cliBackends: ["DEMO-CLI", "Other-CLI"] },
      providerAuthAliases: { " ALIAS ": " dEmO ", BAD: "absent" },
      contracts: { tools: [], webSearchProviders: ["demo-search"] },
    });
    const env = hermeticEnv();
    const index = deriveRegistry(candidate, { env });
    const lookUpTable = loadPluginLookUpTable({ config: {}, env, index });
    for (const indexed of [false, true]) {
      if (indexed) {
        fs.unlinkSync(path.join(rootDir, "openclaw.plugin.json"));
      }
      const source = indexed ? { lookUpTable } : { index };
      for (const [contribution, ids] of [
        ["providers", ["Demo"]],
        ["cliBackends", ["DEMO-CLI", "Other-CLI"]],
        ["contracts", ["webSearchProviders"]],
      ] as const) {
        expect(listPluginContributionIds({ ...source, contribution })).toEqual(ids);
      }
      for (const [contribution, id, indexedOwner, rawOwner] of [
        ["providers", "Demo", true, true],
        ["providers", "demo", false, false],
        ["providers", "alias", true, false],
        ["providers", "ALIAS", false, false],
        ["providers", "bad", false, false],
        ["cliBackends", "demo-cli", true, false],
        ["cliBackends", "DEMO-CLI", false, true],
        ["cliBackends", "other-cli", true, false],
        ["contracts", "tools", false, false],
        ["contracts", "webSearchProviders", true, true],
      ] as const) {
        const query = { ...source, contribution };
        expect(resolvePluginContributionOwners({ ...query, matches: id })).toEqual(
          (indexed ? indexedOwner : rawOwner) ? ["demo"] : [],
        );
        expect(
          resolvePluginContributionOwners({ ...query, matches: (value) => value === id }),
        ).toEqual(rawOwner ? ["demo"] : []);
        expect(resolvePluginContributionOwners({ ...query, matches: "missing" })).toEqual([]);
      }
    }
    expect(
      resolvePluginContributionOwners({
        lookUpTable,
        contribution: "providers",
        matches: (id) => id.trim().toLowerCase() === "demo",
      }),
    ).toEqual(["demo"]);

    const policies: Array<[OpenClawConfig["plugins"], boolean]> = [
      [undefined, true],
      [{ enabled: false }, false],
      [{ deny: ["demo"] }, false],
      [{ allow: ["other"] }, false],
      [{ allow: ["demo"] }, true],
      [{ entries: { demo: { enabled: false } } }, false],
      [{ entries: { demo: { enabled: true } } }, true],
    ];
    for (const matches of ["Demo", (id: string) => id === "Demo"]) {
      for (const [plugins, enabled] of policies) {
        const params = {
          lookUpTable,
          ...(plugins ? { config: { plugins } } : {}),
          contribution: "providers" as const,
          matches,
        };
        expect(resolvePluginContributionOwners(params)).toEqual(enabled ? ["demo"] : []);
        expect(resolvePluginContributionOwners({ ...params, includeDisabled: true })).toEqual([
          "demo",
        ]);
      }
    }

    const withoutInstalledOwners = {
      lookUpTable: { ...lookUpTable, index: { ...index, plugins: [] } },
      contribution: "providers" as const,
      includeDisabled: true,
    };
    expect(listPluginContributionIds(withoutInstalledOwners)).toEqual([]);
    for (const matches of ["Demo", (id: string) => id === "Demo"]) {
      expect(resolvePluginContributionOwners({ ...withoutInstalledOwners, matches })).toEqual([]);
    }
  });

  it("prepares aliases once per immutable inventory and manifest view", () => {
    const build = vi.spyOn(manifestIdNormalizer, "createPluginManifestIdNormalizer");
    const index = createIndex("installed-only");
    freezeTrustedJsonSnapshot(index);
    const first = makePluginMetadataManifestRegistry("first");
    const second = makePluginMetadataManifestRegistry("second");
    first.plugins[0]!.providers = ["shared-alias"];
    second.plugins[0]!.providers = ["shared-alias"];
    try {
      for (let turn = 0; turn < 10; turn++) {
        for (const [manifestRegistry, owner] of [
          [first, "first"],
          [second, "second"],
        ] as const) {
          expect(
            normalizePluginsConfigWithRegistry(
              {
                allow: ["shared-alias", "INSTALLED-ONLY"],
                entries: { [owner]: { enabled: turn % 2 === 0 } },
              },
              index,
              { manifestRegistry },
            ),
          ).toMatchObject({
            allow: [owner, "installed-only"],
            entries: { [owner]: { enabled: turn % 2 === 0 } },
          });
        }
      }
      expect(build).toHaveBeenCalledTimes(2);

      const replacement = createIndex("replacement");
      freezeTrustedJsonSnapshot(replacement);
      const normalizeReplacement = createPluginRegistryIdNormalizer(replacement, {
        manifestRegistry: first,
      });
      expect(normalizeReplacement("INSTALLED-ONLY")).toBe("INSTALLED-ONLY");
      expect(normalizeReplacement("REPLACEMENT")).toBe("replacement");
      expect(build).toHaveBeenCalledTimes(3);

      clearPluginMetadataLifecycleCaches();
      createPluginRegistryIdNormalizer(index, { manifestRegistry: first });
      expect(build).toHaveBeenCalledTimes(4);

      const mutable = createIndex("before");
      expect(createPluginRegistryIdNormalizer(mutable, { manifestRegistry: first })("BEFORE")).toBe(
        "before",
      );
      mutable.plugins[0]!.pluginId = "after";
      expect(createPluginRegistryIdNormalizer(mutable, { manifestRegistry: first })("AFTER")).toBe(
        "after",
      );
      expect(build).toHaveBeenCalledTimes(6);
    } finally {
      build.mockRestore();
    }
  });

  it.each([false, true])(
    "normalizes plugin config ids (provided manifest registry: %s)",
    (provided) => {
      const rootDir = makeTempDir();
      fs.writeFileSync(path.join(rootDir, "index.ts"), "", "utf8");
      writeJson(path.join(rootDir, "openclaw.plugin.json"), {
        id: "openai",
        legacyPluginIds: ["openai-codex"],
        configSchema: { type: "object" },
        providers: ["openai", "openai"],
        channels: ["openai-chat"],
      });
      const index = createIndex("openai", {}, { rootDir });
      const options = provided
        ? {
            manifestRegistry: loadPluginLookUpTable({ config: {}, env: hermeticEnv(), index })
              .manifestRegistry,
          }
        : {};
      if (provided) {
        fs.unlinkSync(path.join(rootDir, "openclaw.plugin.json"));
      }
      const normalizePluginId = createPluginRegistryIdNormalizer(index, options);
      expect(["OpenAI-Codex", "openai-chat", "unknown-plugin"].map(normalizePluginId)).toEqual([
        "openai",
        "openai",
        "unknown-plugin",
      ]);

      const normalizedConfig = normalizePluginsConfigWithRegistry(
        { allow: ["openai-chat"], entries: { "OpenAI-Codex": { enabled: false } } },
        index,
        options,
      );
      expect(normalizedConfig).toMatchObject({
        allow: ["openai"],
        entries: { openai: { enabled: false } },
      });
    },
  );

  it("keeps content-equivalent timestamp changes on the persisted path", async () => {
    const fixture = candidateFixture();
    const persisted = structuredClone(fixture.derive());
    expectDefined(persisted.plugins[0], "persisted plugin").syntheticAuthRefs = ["demo"];
    await fixture.persist(persisted);
    const manifestPath = path.join(fixture.rootDir, "openclaw.plugin.json");
    const future = new Date(Date.now() + 1_000);
    fs.utimesSync(manifestPath, future, future);

    const result = fixture.load({ candidates: undefined });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins[0]?.syntheticAuthRefs).toEqual(["demo"]);
  });

  it("reads install records from a custom SQLite registry path", async () => {
    const tempDir = makeTempDir();
    const rootDir = makeTempDir();
    const filePath = path.join(tempDir, "custom-registry.sqlite");
    const env = hermeticEnv({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_STATE_DIR: tempDir });
    const installRecords = {
      demo: { source: "npm" as const, spec: "demo@1.0.0", installPath: rootDir },
    };
    const persisted = deriveRegistry(createCandidate(rootDir, "demo", "demo"), {
      installRecords,
      env,
    });
    await writePersistedInstalledPluginIndex(persisted, { filePath });

    const result = loadPluginRegistrySnapshotWithMetadata({ filePath, env });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.installRecords?.demo).toMatchObject({
      source: "npm",
      spec: "demo@1.0.0",
      installPath: rootDir,
    });
  });

  it("falls back to the derived registry when persisted package metadata disappears", async () => {
    const fixture = candidateFixture({ config: {} });
    const { rootDir, candidate } = fixture;
    writeJson(path.join(rootDir, "package.json"), { name: "demo-plugin", version: "1.0.0" });
    Object.assign(candidate, {
      packageDir: rootDir,
      packageName: "demo-plugin",
      packageVersion: "1.0.0",
    });
    const persisted = fixture.derive();
    await fixture.persist(persisted);
    fs.rmSync(path.join(rootDir, "package.json"));

    const result = fixture.load();

    expectStale(result);
    expect(result.snapshot.plugins[0]?.packageJson).toBeUndefined();
  });

  it.each(["bundled roots", "policy"] as const)(
    "falls back to the derived registry when persisted %s are stale",
    async (stale) => {
      const fixture = candidateFixture();
      let index: InstalledPluginIndex;
      if (stale === "bundled roots") {
        const rootDir = makeTempDir();
        createCandidate(rootDir);
        index = createIndex("persisted", {}, { rootDir, origin: "bundled" });
        fixture.env = hermeticEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: fixture.rootDir });
      } else {
        index = createIndex("persisted", {
          policyHash: resolveInstalledPluginIndexPolicyHash({
            plugins: { entries: { persisted: { enabled: true } } },
          }),
          installRecords: {
            persisted: {
              source: "npm",
              spec: "persisted-plugin@1.0.0",
              installPath: path.join(fixture.stateDir, "plugins", "persisted"),
            },
          },
        });
      }
      await fixture.persist(index);
      const result = fixture.load(
        stale === "bundled roots"
          ? { env: fixture.env }
          : { config: { plugins: { entries: { demo: { enabled: true } } } } },
      );
      expectStale(result, `persisted-registry-stale-${stale === "policy" ? "policy" : "source"}`);
      expectSnapshotPluginIds(result.snapshot, ["demo"]);
      if (stale === "policy") {
        expect(result.snapshot.installRecords?.persisted).toMatchObject({
          source: "npm",
          spec: "persisted-plugin@1.0.0",
        });
      }
    },
  );

  it("migrates legacy source records and accepts dist-opt-out plugins", async () => {
    const tempRoot = makeTempDir();
    const stateDir = path.join(tempRoot, "state");
    const packageRoot = path.join(tempRoot, "openclaw");
    const sourceRoot = path.join(packageRoot, "extensions", "demo");
    const builtRoot = path.join(packageRoot, "dist", "extensions", "demo");
    fs.mkdirSync(path.join(packageRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.mkdirSync(builtRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n");
    const sourceCandidate = {
      ...createCandidate(sourceRoot),
      origin: "bundled" as const,
      packageDir: sourceRoot,
      packageManifest: { extensions: ["./index.ts"], build: { bundledDist: false } },
    } satisfies PluginCandidate;
    const packageJson = JSON.stringify({ openclaw: sourceCandidate.packageManifest });
    fs.writeFileSync(path.join(sourceRoot, "package.json"), packageJson);
    for (const file of ["openclaw.plugin.json", "index.ts"]) {
      fs.copyFileSync(path.join(sourceRoot, file), path.join(builtRoot, file));
    }
    fs.writeFileSync(path.join(builtRoot, "package.json"), packageJson);
    const env = hermeticEnv({
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(builtRoot),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    });
    const freshIndex = deriveRegistry(sourceCandidate, { env });
    const params = { stateDir, candidates: [sourceCandidate], env };
    await writePersistedInstalledPluginIndex(freshIndex, { stateDir });

    const persisted = loadPluginRegistrySnapshotWithMetadata(params);
    expect(persisted.source).toBe("persisted");
    expect(persisted.diagnostics).toStrictEqual([]);

    const legacySourceIndex = structuredClone(freshIndex);
    for (const plugin of legacySourceIndex.plugins) {
      delete plugin.packageBuild;
    }
    await writePersistedInstalledPluginIndex(legacySourceIndex, { stateDir });
    const migrated = loadPluginRegistrySnapshotWithMetadata(params);
    expectStale(migrated);
  });

  it("projects a config policy change over the persisted inventory without rescanning", async () => {
    const { env, extensionsDir, load, persist } = profileFixture();
    // Bundled plugins are disabled here, so the default memory slot owner is absent.
    const enabled: OpenClawConfig = { plugins: { slots: { memory: "none" } } };
    const installed = await persist(enabled);
    expect(installed.snapshot.plugins.map((plugin) => [plugin.pluginId, plugin.enabled])).toEqual([
      ["demo", true],
    ]);
    const disabled: OpenClawConfig = {
      plugins: { slots: { memory: "none" }, entries: { demo: { enabled: false } } },
    };
    const readdir = vi.spyOn(fs, "readdirSync");
    const result = load(disabled);
    // Discovery lists the extensions root; freshness checks may still read plugin dirs.
    expect(readdir.mock.calls.filter(([dir]) => String(dir) === extensionsDir)).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "persisted-registry-stale-policy",
    ]);
    expect(result.snapshot.policyHash).toBe(resolveInstalledPluginIndexPolicyHash(disabled, env));
    expect(result.snapshot.plugins.map((plugin) => [plugin.pluginId, plugin.enabled])).toEqual([
      ["demo", false],
    ]);
  });

  it("rediscovers when a policy enables a persisted plugin whose files are gone", async () => {
    const { pluginRoot, load, persist } = profileFixture();
    const disabled: OpenClawConfig = {
      plugins: { slots: { memory: "none" }, entries: { demo: { enabled: false } } },
    };
    await persist(disabled);
    // Freshness tolerates missing files only while the persisted record is disabled.
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    clearPluginMetadataLifecycleCaches();

    const result = load({ plugins: { slots: { memory: "none" } } });

    expect(result.source).toBe("derived");
    expect(result.snapshot.plugins.filter((plugin) => plugin.enabled)).toEqual([]);
  });

  it("reloads profile extensions after the metadata lifecycle is cleared", () => {
    const { load, addPlugin } = profileFixture("first");
    const first = load();
    addPlugin("second");
    clearPluginMetadataLifecycleCaches();
    const second = load();

    expect(first.source).toBe("derived");
    expect(second.source).toBe("derived");
    expectSnapshotPluginIds(first.snapshot, ["first"]);
    expectSnapshotPluginIds(second.snapshot, ["first", "second"]);
  });
});
