import fs from "node:fs";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordPluginCandidateInstallOwner } from "./candidate-install-owner.js";
import type { PluginCandidate } from "./discovery.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import {
  diffInstalledPluginIndexInvalidationReasons,
  isInstalledPluginEnabled,
  loadInstalledPluginIndex as loadIndex,
} from "./installed-plugin-index.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

vi.unmock("../version.js");

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index", tempDirs);
}

function writePluginManifest(rootDir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ configSchema: { type: "object" }, ...manifest }),
    "utf-8",
  );
}

function writePackageJson(rootDir: string, version = "1.2.3", name = "@vendor/demo-plugin") {
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ name, version }), "utf-8");
}

function writeRuntimeEntry(rootDir: string) {
  fs.writeFileSync(path.join(rootDir, "index.ts"), "throw new Error('runtime loaded');\n", "utf-8");
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function expectSha256(value: unknown) {
  expect(value).toMatch(/^[a-f0-9]{64}$/u);
}

function writeManifestlessClaudeBundle(rootDir: string, entries: readonly string[] = ["skills"]) {
  for (const entry of entries) {
    fs.mkdirSync(path.join(rootDir, entry), { recursive: true });
    fs.writeFileSync(path.join(rootDir, entry, "README.md"), `# ${entry}\n`, "utf-8");
  }
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function loadInstalledPluginIndex(params: Parameters<typeof loadIndex>[0]) {
  return loadIndex({ env: hermeticEnv(), ...params });
}

function entryConfig(id: string, enabled: boolean): OpenClawConfig {
  return { plugins: { entries: { [id]: { enabled } } } };
}

function createPluginCandidate({
  rootDir,
  installOwner,
  ...overrides
}: Partial<PluginCandidate> & { rootDir: string; installOwner?: string }): PluginCandidate {
  return recordPluginCandidateInstallOwner(
    {
      idHint: "demo",
      origin: "global",
      packageDir: rootDir,
      ...overrides,
      rootDir,
      source: overrides.format === "bundle" ? rootDir : path.join(rootDir, "index.ts"),
    },
    installOwner,
  );
}

const packageChannel = {
  id: "demo",
  label: "Demo",
  blurb: "Demo channel",
  preferOver: ["legacy-demo"],
  commands: { nativeCommandsAutoEnabled: true, nativeSkillsAutoEnabled: false },
};

function createManifestFixture(
  manifest: Record<string, unknown>,
  options: Partial<PluginCandidate> & { installOwner?: string } = {},
) {
  const rootDir = makeTempDir();
  writeRuntimeEntry(rootDir);
  writePluginManifest(rootDir, manifest);
  return createPluginCandidate({ rootDir, ...options });
}

function createRichPluginFixture(params: { id?: string; installOwner?: string } = {}) {
  const id = params.id ?? "demo";
  const candidate = createManifestFixture(
    {
      id,
      name: "Demo",
      providers: ["demo"],
      channels: ["demo-chat"],
      cliBackends: ["demo-cli"],
      channelConfigs: { "demo-chat": { schema: { type: "object" } } },
      modelCatalog: {
        providers: { demo: { models: [{ id: "demo-model" }] } },
        discovery: { demo: "static" },
      },
      commandAliases: [{ name: "demo-command" }],
      contracts: { tools: ["demo-tool"] },
      syntheticAuthRefs: ["demo", "demo-cli"],
      activation: {
        onAgentHarnesses: ["codex"],
        onProviders: ["demo"],
        onChannels: ["demo-chat"],
      },
    },
    {
      packageName: "@vendor/demo-plugin",
      packageVersion: "1.2.3",
      packageManifest: {
        build: { bundledDist: false },
        channel: structuredClone(packageChannel),
        install: {
          npmSpec: "@vendor/demo-plugin@1.2.3",
          expectedIntegrity: "sha512-demo",
          defaultChoice: "npm",
        },
      },
      installOwner: params.installOwner,
    },
  );
  const rootDir = candidate.rootDir;
  writePackageJson(rootDir, "1.2.3", `@vendor/${id}`);
  return {
    rootDir,
    candidate,
    load: (overrides: Parameters<typeof loadIndex>[0] = {}) =>
      loadInstalledPluginIndex({ candidates: [candidate], ...overrides }),
  };
}

describe("installed plugin index", () => {
  it("builds a runtime-free installed plugin snapshot from manifest and package metadata", () => {
    const fixture = createRichPluginFixture();

    const index = fixture.load({ now: () => new Date("2026-04-25T12:00:00.000Z") });

    expect(index).toMatchObject({
      version: 1,
      migrationVersion: 1,
      generatedAtMs: 1777118400000,
    });
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expect(plugin).toMatchObject({
      pluginId: "demo",
      packageName: "@vendor/demo-plugin",
      packageVersion: "1.2.3",
      origin: "global",
      rootDir: fixture.rootDir,
      source: path.join(fixture.rootDir, "index.ts"),
      enabled: true,
      syntheticAuthRefs: ["demo", "demo-cli"],
      compat: [
        "activation-agent-harness-hint",
        "activation-channel-hint",
        "activation-provider-hint",
      ],
    });
    expect(plugin.packageInstall).toEqual({
      defaultChoice: "npm",
      npm: {
        spec: "@vendor/demo-plugin@1.2.3",
        packageName: "@vendor/demo-plugin",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        expectedIntegrity: "sha512-demo",
        pinState: "exact-with-integrity",
      },
      warnings: [],
    });
    expect(plugin.packageChannel).toEqual(packageChannel);
    expect(plugin.packageBuild).toEqual({ bundledDist: false });
    expectSha256(plugin.manifestHash);
    const packageJson = requireRecord(index.plugins[0]?.packageJson, "package json");
    expect(packageJson).toMatchObject({ path: "package.json" });
    expectSha256(packageJson.hash);
    expect(resolveInstalledPluginIndexInstallOwner(plugin)).toBeUndefined();
    expect(index.plugins[0]?.installRecordHash).toBeUndefined();
  });

  it.each([
    [
      "startup opt-out",
      { id: "modern-inert", activation: { onStartup: false } },
      { compat: [], startup: { sidecar: false } },
    ],
    [
      "explicit startup",
      { id: "explicit-startup-provider", providers: ["demo"], activation: { onStartup: true } },
      { startup: { sidecar: true } },
    ],
  ] as const)("classifies %s sidecars", (_name, manifest, expected) => {
    const index = loadInstalledPluginIndex({ candidates: [createManifestFixture(manifest)] });
    expect(index.plugins[0]).toMatchObject({
      pluginId: manifest.id,
      ...expected,
    });
  });

  it.each([
    ["stale records without normalized channels", "stale-record", "demo", undefined],
    ["inherited prototype names", "toString", "toString", "toString"],
  ] as const)("handles %s", (_name, id, idHint, installOwner) => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");

    const records = buildInstalledPluginIndexRecords({
      candidates: [createPluginCandidate({ rootDir, idHint, installOwner })],
      registry: {
        plugins: [
          {
            id,
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "global",
            rootDir,
            source: path.join(rootDir, "index.ts"),
            manifestPath,
          } as unknown as PluginManifestRecord,
        ],
        diagnostics: [],
      },
      diagnostics: [],
      installRecords: {},
    });

    expect(records[0]).toMatchObject({
      pluginId: id,
      compat: [],
      startup: { sidecar: false },
    });
    expect(records[0]?.installRecordHash).toBeUndefined();
  });

  it("changes manifestless Claude bundle hashes when derived metadata changes", () => {
    const rootDir = path.join(makeTempDir(), "workspace");
    writeManifestlessClaudeBundle(rootDir, ["skills"]);
    const params = {
      candidates: [
        createPluginCandidate({
          rootDir,
          idHint: "workspace",
          format: "bundle",
          bundleFormat: "claude",
          origin: "config",
        }),
      ],
    };
    const first = loadInstalledPluginIndex(params);
    writeManifestlessClaudeBundle(rootDir, ["commands"]);
    const second = withPluginCache(createPluginCache(), () => loadInstalledPluginIndex(params));

    expect(second.plugins[0]?.manifestHash).not.toBe(first.plugins[0]?.manifestHash);
  });

  it("keeps packageJson paths root-relative when packageDir is reached through a symlink", () => {
    const fixture = createRichPluginFixture();
    const linkParent = makeTempDir();
    const linkRoot = path.join(linkParent, "linked-demo");
    try {
      fs.symlinkSync(fixture.rootDir, linkRoot, "dir");
    } catch {
      return;
    }

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir: fs.realpathSync(fixture.rootDir),
          packageDir: linkRoot,
          packageName: "@vendor/demo-plugin",
          packageVersion: "1.2.3",
        }),
      ],
    });

    expect(index.plugins[0]?.packageJson?.path).toBe("package.json");
  });

  it.runIf(process.platform !== "win32")(
    "does not record packageJson metadata from symlinks outside the plugin root",
    () => {
      const fixture = createRichPluginFixture();
      const outsideDir = makeTempDir();
      const packageJsonPath = path.join(fixture.rootDir, "package.json");
      const outsidePackageJsonPath = path.join(outsideDir, "package.json");
      fs.rmSync(packageJsonPath);
      writePackageJson(outsideDir, "9.9.9", "@vendor/outside-plugin");
      fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);

      const index = fixture.load();

      expect(index.plugins[0]?.packageJson).toBeUndefined();
    },
  );

  it("retains disabled plugin metadata while evaluating live enablement", () => {
    const enabledFixture = createRichPluginFixture({ id: "enabled-demo" });
    const disabledFixture = createRichPluginFixture({ id: "disabled-demo" });
    const config = entryConfig("disabled-demo", false);
    const index = loadInstalledPluginIndex({
      candidates: [enabledFixture.candidate, disabledFixture.candidate],
      config,
    });

    const disabled = index.plugins.find((plugin) => plugin.pluginId === "disabled-demo");
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.contributions).toEqual(
      expect.objectContaining({
        channels: ["demo-chat"],
        channelConfigs: ["demo-chat"],
        providers: ["demo"],
        modelCatalogProviders: ["demo"],
        commandAliases: ["demo-command"],
        contracts: { tools: ["demo-tool"] },
      }),
    );
    expect(isInstalledPluginEnabled(index, "disabled-demo", config)).toBe(false);
    expect(
      isInstalledPluginEnabled(index, "disabled-demo", entryConfig("enabled-demo", true)),
    ).toBe(true);
    expect(isInstalledPluginEnabled(index, "disabled-demo")).toBe(false);
    expect(
      isInstalledPluginEnabled(index, "disabled-demo", {
        plugins: { deny: ["disabled-demo"] },
      }),
    ).toBe(false);
  });

  it.each([
    { channelEnabled: false, expected: false },
    { channelEnabled: true, expected: true },
  ])(
    "resolves channels.<id>.enabled=$channelEnabled through the record's channel ids when they differ from the plugin id",
    ({ channelEnabled, expected }) => {
      // The rich fixture's plugin id is `demo` while it owns `channels.demo-chat`.
      const fixture = createRichPluginFixture({ id: "demo" });
      const index = fixture.load({ config: {} });

      expect(
        isInstalledPluginEnabled(index, "demo", {
          channels: { "demo-chat": { enabled: channelEnabled } },
          plugins: { entries: { demo: { enabled: true } } },
        } as OpenClawConfig),
      ).toBe(expected);
    },
  );

  it("uses in-flight install records to rank installed globals over bundled duplicates", () => {
    const bundled = createManifestFixture(
      { id: "duplicate-demo" },
      { idHint: "duplicate-demo", origin: "bundled" },
    );
    const global = createManifestFixture(
      { id: "duplicate-demo" },
      { idHint: "duplicate-demo", origin: "global", installOwner: "duplicate-demo" },
    );
    const globalDir = global.rootDir;
    const installRecords = { "duplicate-demo": { source: "npm" as const, installPath: globalDir } };

    const index = loadInstalledPluginIndex({
      candidates: [bundled, global],
      installRecords,
    });

    expect(index.installRecords).toEqual(installRecords);
    expect(index.plugins).toHaveLength(1);
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expect(plugin).toMatchObject({
      pluginId: "duplicate-demo",
      origin: "global",
      rootDir: globalDir,
    });
    expectSha256(plugin.installRecordHash);
  });

  it("discovers installed plugin packages from persisted install records", async () => {
    const fixture = createRichPluginFixture();
    const stateDir = makeTempDir();
    const installRecords = {
      demo: {
        source: "git" as const,
        spec: "git:file:///tmp/demo.git@abc123",
        installPath: fixture.rootDir,
        gitUrl: "file:///tmp/demo.git",
        gitCommit: "abc123",
      },
    };
    await seedInstalledPluginIndex(installRecords, { stateDir });

    const index = loadInstalledPluginIndex({
      env: hermeticEnv({
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
      }),
    });

    expect(index.plugins).toHaveLength(1);
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expect(plugin).toMatchObject({
      pluginId: "demo",
      origin: "global",
      rootDir: fs.realpathSync.native(fixture.rootDir),
    });
    expectSha256(plugin.installRecordHash);
    expect(index.installRecords).toEqual(installRecords);
  });

  it("does not mark enabled-only migration snapshots stale for omitted disabled plugins", () => {
    const enabledFixture = createRichPluginFixture();
    const disabledFixture = createRichPluginFixture();
    writePluginManifest(disabledFixture.rootDir, {
      id: "disabled-demo",
      name: "Disabled Demo",
      providers: ["disabled-demo"],
    });
    const current = loadInstalledPluginIndex({
      candidates: [
        enabledFixture.candidate,
        {
          ...disabledFixture.candidate,
          idHint: "disabled-demo",
        },
      ],
      config: entryConfig("disabled-demo", false),
    });
    const migratedEnabledOnly = {
      ...current,
      refreshReason: "migration" as const,
      plugins: current.plugins.filter((plugin) => plugin.enabled),
    };

    expect(diffInstalledPluginIndexInvalidationReasons(migratedEnabledOnly, current)).toStrictEqual(
      [],
    );
  });

  it("diffs invalidation reasons for manifest, package, source, host, compat, and migration changes", () => {
    const fixture = createRichPluginFixture({ installOwner: "demo" });
    const npmRecords = (resolvedVersion: string) => ({
      demo: { source: "npm" as const, resolvedVersion },
    });
    const previous = fixture.load({
      config: { plugins: { installs: npmRecords("1.2.3") } },
    });

    writePackageJson(fixture.rootDir, "1.2.4");
    writePluginManifest(fixture.rootDir, { id: "demo", providers: ["demo", "demo-next"] });
    const current = {
      ...withPluginCache(createPluginCache(), () =>
        loadInstalledPluginIndex({
          candidates: [
            {
              ...fixture.candidate,
              packageVersion: "1.2.4",
            },
          ],
          installRecords: npmRecords("1.2.4"),
          env: hermeticEnv({ OPENCLAW_VERSION: "2026.4.26" }),
        }),
      ),
      compatRegistryVersion: "different-compat-registry",
    };

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toEqual([
      "compat-registry-changed",
      "host-contract-changed",
      "source-changed",
      "stale-manifest",
      "stale-package",
    ]);

    const moved = {
      ...current,
      plugins: current.plugins.map((plugin) => ({
        ...plugin,
        rootDir: path.join(plugin.rootDir, "moved"),
      })),
    };
    expect(diffInstalledPluginIndexInvalidationReasons(current, moved)).toContain("source-changed");
  });
});
