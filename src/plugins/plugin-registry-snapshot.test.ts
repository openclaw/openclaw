import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import type { PluginCandidate } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import {
  loadInstalledPluginIndex,
  resolveInstalledPluginIndexPolicyHash,
  type InstalledPluginIndex,
} from "./installed-plugin-index.js";
import { markRetainedManagedNpmInstall } from "./managed-npm-retention.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-snapshot.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";
import { writeRegistryPackagePlugin } from "./test-helpers/plugin-registry-snapshot.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-registry-snapshot", tempDirs);
}

function createHermeticEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
}

function isolatedRegistry() {
  const tempRoot = makeTempDir();
  return {
    tempRoot,
    stateDir: path.join(tempRoot, "state"),
    env: { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  };
}

function configuredRegistry(disabled = false) {
  const fixture = isolatedRegistry();
  const rootDir = path.join(fixture.tempRoot, "workspace");
  const config = {
    plugins: {
      load: { paths: [rootDir] },
      ...(disabled ? { entries: { demo: { enabled: false } } } : {}),
    },
  };
  return { ...fixture, rootDir, config };
}

function bundledRegistry() {
  const tempRoot = makeTempDir();
  const packageRoot = path.join(tempRoot, "openclaw");
  const bundledRoot = path.join(packageRoot, "dist", "extensions");
  const sourceRoot = path.join(packageRoot, "extensions");
  const stateDir = path.join(tempRoot, "state");
  const env: NodeJS.ProcessEnv = {
    ...createHermeticEnv(tempRoot),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
  };
  return { tempRoot, packageRoot, bundledRoot, sourceRoot, stateDir, env };
}

function disabledBundledRegistry() {
  const tempRoot = makeTempDir();
  const bundledRoot = path.join(tempRoot, "dist", "extensions");
  const pluginRoot = path.join(bundledRoot, "whatsapp");
  const stateDir = path.join(tempRoot, "state");
  const env = { ...createHermeticEnv(tempRoot), OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot };
  const config = { plugins: { entries: { whatsapp: { enabled: false } } } };
  const contractPath = path.join(pluginRoot, "doctor-contract-api.ts");
  writeBundledPlugin(pluginRoot, "whatsapp", "index.js");
  fs.writeFileSync(contractPath, "export const stateMigrations = [];\n", "utf8");
  return { pluginRoot, stateDir, env, config, contractPath };
}

function writeCheckout(packageRoot: string) {
  fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, ".git"), "gitdir: /tmp/mock\n", "utf8");
  fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
}

function writeBundledPlugin(
  rootDir: string,
  pluginId: string,
  entryPath: string,
  build?: Record<string, unknown>,
) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, entryPath), "export default { register() {} };\n", "utf8");
  writeJson(path.join(rootDir, "openclaw.plugin.json"), {
    id: pluginId,
    configSchema: { type: "object" },
  });
  writeJson(path.join(rootDir, "package.json"), {
    name: `@openclaw/${pluginId}`,
    version: "1.0.0",
    openclaw: {
      extensions: [`./${entryPath}`],
      ...(build ? { build } : {}),
    },
  });
}

function mockLinuxMountInfo(mountPoints: readonly string[]) {
  const originalReadFileSync = fs.readFileSync;
  return vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
    if (filePath === "/proc/self/mountinfo") {
      return mountPoints
        .map(
          (mountPoint, index) => `${100 + index} 99 0:${index} / ${mountPoint} rw - tmpfs tmpfs rw`,
        )
        .join("\n");
    }
    return originalReadFileSync(filePath, options as never) as never;
  });
}

function createCandidate(rootDir: string, pluginId = "demo"): PluginCandidate {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default { register() {} };\n", "utf8");
  writeJson(path.join(rootDir, "openclaw.plugin.json"), {
    id: pluginId,
    configSchema: { type: "object" },
    providers: [pluginId],
  });
  return { idHint: pluginId, source: path.join(rootDir, "index.ts"), rootDir, origin: "global" };
}

function replaceFilePreservingSizeAndMtime(filePath: string, contents: string) {
  const previous = fs.statSync(filePath);
  expect(Buffer.byteLength(contents)).toBe(previous.size);
  fs.writeFileSync(filePath, contents, "utf8");
  fs.utimesSync(filePath, previous.atime, previous.mtime);
}

function fileHash(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileSignature(filePath: string) {
  const stat = fs.statSync(filePath);
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function expectDiagnosticsContainCode(diagnostics: readonly { code?: unknown }[], code: string) {
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
}

function requirePluginRecord(
  plugins: InstalledPluginIndex["plugins"],
  pluginId: string,
): InstalledPluginIndex["plugins"][number] {
  return expectDefined(
    plugins.find((candidate) => candidate.pluginId === pluginId),
    `expected plugin ${pluginId}`,
  );
}

function persistFirstPlugin(
  index: InstalledPluginIndex,
  stateDir: string,
  overrides: Partial<InstalledPluginIndex["plugins"][number]>,
) {
  const [plugin, ...rest] = index.plugins;
  return writePersistedInstalledPluginIndex(
    {
      ...index,
      plugins: [{ ...expectDefined(plugin, "expected test plugin"), ...overrides }, ...rest],
    },
    { stateDir },
  );
}

function expectPersisted(result: ReturnType<typeof loadPluginRegistrySnapshotWithMetadata>) {
  expect(result.source).toBe("persisted");
  expect(result.diagnostics).toStrictEqual([]);
}

function expectStale(result: ReturnType<typeof loadPluginRegistrySnapshotWithMetadata>) {
  expect(result.source).toBe("derived");
  expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
}

function packageRegistry(disabled = false) {
  const params = configuredRegistry(disabled);
  writeRegistryPackagePlugin(params.rootDir);
  return { ...params, index: loadInstalledPluginIndex({ config: params.config, env: params.env }) };
}

function dropStartupConfigPaths(
  plugin: InstalledPluginIndex["plugins"][number],
): InstalledPluginIndex["plugins"][number] {
  const { configPaths: _configPaths, ...startup } = plugin.startup;
  return { ...plugin, startup };
}

describe("loadPluginRegistrySnapshotWithMetadata", () => {
  it.each(["persisted", "current"])(
    "reselects checkout plugins for a fresh config request after a %s global selection",
    async (cache) => {
      const root = fs.realpathSync(makeTempDir());
      const packageRoot = path.join(root, "openclaw");
      const bundledRoot = path.join(packageRoot, "dist", "extensions");
      const bundledPlugin = path.join(bundledRoot, "demo");
      const globalPlugin = path.join(root, "state", "extensions", "demo");
      const env: NodeJS.ProcessEnv = {
        ...createHermeticEnv(root),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      };
      fs.mkdirSync(path.join(packageRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(packageRoot, "extensions"));
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      fs.writeFileSync(path.join(packageRoot, "pnpm-workspace.yaml"), "packages: []\n");
      writeBundledPlugin(bundledPlugin, "demo", "index.js");
      writeBundledPlugin(globalPlugin, "demo", "index.js");
      const config = { plugins: { entries: { demo: { enabled: true } } } };
      const index = loadInstalledPluginIndex({
        config,
        env,
        installRecords: {
          demo: { source: "path", sourcePath: globalPlugin, installPath: globalPlugin },
        },
      });
      expect(requirePluginRecord(index.plugins, "demo").origin).toBe("global");
      await writePersistedInstalledPluginIndex(index, { stateDir: env.OPENCLAW_STATE_DIR });
      if (cache === "current") {
        setCurrentPluginMetadataSnapshot(loadPluginMetadataSnapshot({ config, env }), {
          config,
          env,
        });
      }
      const result = loadPluginRegistrySnapshotWithMetadata({
        config: structuredClone(config),
        env: { ...env, OPENCLAW_DEV_SOURCE_ROOT: packageRoot },
      });
      expect(requirePluginRecord(result.snapshot.plugins, "demo")).toMatchObject({
        origin: "bundled",
        rootDir: bundledPlugin,
      });
    },
  );

  it("bypasses a derived current snapshot for persisted verification", async () => {
    const rootDir = makeTempDir();
    const env = { ...createHermeticEnv(rootDir), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {};
    const derived = loadPluginMetadataSnapshot({ config, env, preferPersisted: false });
    expect(derived.registrySource).toBe("derived");
    await writePersistedInstalledPluginIndex(derived.index, { env });
    setCurrentPluginMetadataSnapshot(derived, { config, env });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, allowCurrent: false });

    expect(result.source).toBe("persisted");
    expect(result.snapshot).toEqual(derived.index);
  });

  it("reuses diagnostic current metadata only without explicit derivation inputs", () => {
    const tempRoot = makeTempDir();
    const env = { ...createHermeticEnv(tempRoot), OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
    const config = {};
    const workspaceDir = path.join(tempRoot, "workspace");
    const snapshot = createPluginMetadataSnapshotFixture();
    snapshot.index.policyHash = resolveInstalledPluginIndexPolicyHash(config);
    const index = snapshot.index;
    setCurrentPluginMetadataSnapshot(
      {
        ...snapshot,
        policyHash: snapshot.index.policyHash,
        configFingerprint: "",
        workspaceDir,
        normalizePluginId: (pluginId) => pluginId,
        registrySource: "derived",
        registryDiagnostics: [
          { level: "info", code: "persisted-registry-missing", message: "missing" },
        ],
      },
      { config, env, workspaceDir },
    );
    const readDirectory = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");
    const statFile = vi.spyOn(fs, "statSync");

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, workspaceDir });

    expect(result).toEqual({
      snapshot: index,
      source: "derived",
      diagnostics: [{ level: "info", code: "persisted-registry-missing", message: "missing" }],
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    expect(readDirectory).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(statFile).not.toHaveBeenCalled();

    const explicit = loadPluginRegistrySnapshotWithMetadata({
      config,
      env,
      workspaceDir,
      candidates: [createCandidate(path.join(tempRoot, "candidate"), "explicit")],
    });

    expect(explicit.source).toBe("derived");
    expect(explicit.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["explicit"]);
  });

  it.each<[string, NonNullable<OpenClawConfig["plugins"]>]>([
    ["entry", { entries: { "memory-demo": { enabled: true } } }],
    ["allowlist", { allow: ["memory-demo"] }],
    ["memory slot", { slots: { memory: " memory-demo " } }],
    ["context-engine slot", { slots: { contextEngine: " memory-demo " } }],
  ])(
    "recovers a global source plugin selected by %s from a stale registry",
    async (_selection, plugins) => {
      const { stateDir, env } = isolatedRegistry();
      const config = { plugins };
      const staleIndex = loadInstalledPluginIndex({ config, env, stateDir, installRecords: {} });
      expect(staleIndex.plugins.map((plugin) => plugin.pluginId)).not.toContain("memory-demo");
      await writePersistedInstalledPluginIndex(staleIndex, { stateDir });
      writeRegistryPackagePlugin(path.join(stateDir, "extensions", "memory-demo-source"), {
        pluginId: "memory-demo",
      });

      const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

      expect(result.source).toBe("derived");
      expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
      const memoryPlugin = requirePluginRecord(result.snapshot.plugins, "memory-demo");
      expect(memoryPlugin.origin).toBe("global");
    },
  );

  it("does not recover retained managed npm generations as install records", async () => {
    const { stateDir, env } = isolatedRegistry();
    const config = {};
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.6.10-beta.1",
    });
    await markRetainedManagedNpmInstall({
      packageDir: codexDir,
      pluginId: "codex",
      retainedAt: "2026-06-21T00:00:00.000Z",
      reason: "test-retained-generation",
    });
    const staleIndex = loadInstalledPluginIndex({ config, env, stateDir, installRecords: {} });
    await writePersistedInstalledPluginIndex(staleIndex, { stateDir });

    expect(loadInstalledPluginIndexInstallRecordsSync({ env, stateDir }).codex).toBeUndefined();
    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.snapshot.installRecords.codex).toBeUndefined();
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).not.toContain("codex");
  });

  it("does not trust package-owned retained npm marker files during recovery", () => {
    const { stateDir, env } = isolatedRegistry();
    const codexDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/codex",
      pluginId: "codex",
      version: "2026.6.10-beta.1",
    });
    fs.writeFileSync(
      path.join(codexDir, ".openclaw-retained-npm-install.json"),
      '{"version":1,"pluginId":"codex"}\n',
      "utf8",
    );

    expect(loadInstalledPluginIndexInstallRecordsSync({ env, stateDir }).codex).toBeDefined();
  });

  it("keeps unrelated installed plugins usable beside a vanished package owner", async () => {
    const { stateDir, env } = isolatedRegistry();
    const demoDir = path.join(stateDir, "extensions", "demo");
    const goneDir = path.join(stateDir, "extensions", "gone");
    writeRegistryPackagePlugin(demoDir, { pluginId: "demo" });
    const config = { plugins: { entries: { demo: { enabled: true }, gone: { enabled: true } } } };
    const installRecords = {
      demo: { source: "path" as const, sourcePath: demoDir, installPath: demoDir },
      gone: { source: "path" as const, sourcePath: goneDir, installPath: goneDir },
    };
    const index = loadInstalledPluginIndex({ config, env, stateDir, installRecords });
    await writePersistedInstalledPluginIndex(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toContain("demo");
  });

  it("keeps persisted manifestless Claude bundles on the fast path", async () => {
    const { rootDir, stateDir, env, config } = configuredRegistry();
    fs.mkdirSync(path.join(rootDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "skills", "SKILL.md"), "# Workspace skill\n", "utf8");
    const index = loadInstalledPluginIndex({ config, env });
    await writePersistedInstalledPluginIndex(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectPersisted(result);
  });

  it("derives a complete index when a configured load-path plugin is missing", async () => {
    const { tempRoot, stateDir, env } = isolatedRegistry();
    const firstRoot = path.join(tempRoot, "first");
    const secondRoot = path.join(tempRoot, "second");
    const staleConfig = { plugins: { load: { paths: [firstRoot] } } };
    const config = { plugins: { load: { paths: [firstRoot, secondRoot] } } };
    writeRegistryPackagePlugin(firstRoot, { pluginId: "first", requiresPlugins: ["second"] });
    writeRegistryPackagePlugin(secondRoot, { pluginId: "second" });
    const staleIndex = loadInstalledPluginIndex({ config: staleConfig, env });
    expect(staleIndex.policyHash).toBe(resolveInstalledPluginIndexPolicyHash(config));
    await writePersistedInstalledPluginIndex(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectStale(result);
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["first", "second"]);
    expect(result.snapshot.plugins.map((plugin) => plugin.origin)).toEqual(["config", "config"]);
    const scopedRegistry = loadPluginManifestRegistryForInstalledIndex({
      index: result.snapshot,
      config,
      env,
      pluginIds: ["first"],
      includeDisabled: true,
    });
    expect(scopedRegistry.plugins.map((plugin) => plugin.id)).toEqual(["first"]);
    expect(scopedRegistry.diagnostics).not.toContainEqual(
      expect.objectContaining({
        pluginId: "first",
        message: expect.stringContaining('requires plugin "second"'),
      }),
    );
  });

  it("rebuilds legacy config-path persisted registries before startup scoping", async () => {
    const { rootDir, stateDir, env, config } = configuredRegistry();
    writeRegistryPackagePlugin(rootDir, { configPaths: ["browser"] });
    const index = loadInstalledPluginIndex({ config, env });
    const legacyIndex: InstalledPluginIndex = {
      ...index,
      plugins: index.plugins.map(dropStartupConfigPaths),
    };
    await writePersistedInstalledPluginIndex(legacyIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectStale(result);
    expect(result.snapshot.plugins[0]?.startup.configPaths).toEqual(["browser"]);
  });

  it("keeps persisted package plugins with dot-prefixed package metadata paths", async () => {
    const { rootDir, stateDir, env, config } = configuredRegistry();
    writeRegistryPackagePlugin(rootDir);
    const metaDir = path.join(rootDir, "..meta");
    fs.mkdirSync(metaDir, { recursive: true });
    const packageJsonPath = path.join(metaDir, "package.json");
    writeJson(packageJsonPath, {
      name: "demo",
      version: "1.0.0",
      openclaw: {
        channel: {
          id: "demo",
          label: "Demo",
          commands: { nativeCommandsAutoEnabled: true, nativeSkillsAutoEnabled: false },
        },
      },
    });
    const index = loadInstalledPluginIndex({ config, env });
    await persistFirstPlugin(index, stateDir, {
      packageJson: {
        path: "..meta/package.json",
        hash: fileHash(packageJsonPath),
        fileSignature: fileSignature(packageJsonPath),
      },
    });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectPersisted(result);
    expect(result.manifestRegistry).toBeUndefined();
    const registry = loadPluginManifestRegistryForInstalledIndex({
      index: result.snapshot,
      config,
      env,
      includeDisabled: true,
    });
    expect(registry.plugins[0]?.channelCatalogMeta?.commands).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "treats persisted package metadata symlinks outside the plugin root as stale",
    async () => {
      const { tempRoot, rootDir, stateDir, env, config } = configuredRegistry(true);
      const outsideDir = path.join(tempRoot, "outside");
      const packageJsonPath = path.join(rootDir, "package.json");
      const outsidePackageJsonPath = path.join(outsideDir, "package.json");
      writeRegistryPackagePlugin(rootDir);
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.rmSync(packageJsonPath);
      writeJson(outsidePackageJsonPath, { name: "demo", version: "1.0.0" });
      fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);
      const index = loadInstalledPluginIndex({ config, env });
      await persistFirstPlugin(index, stateDir, {
        packageJson: {
          path: "package.json",
          hash: fileHash(packageJsonPath),
          fileSignature: fileSignature(packageJsonPath),
        },
      });

      const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

      expect(result.source).toBe("derived");
      expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects dangling root, source, and manifest links for disabled records",
    async () => {
      for (const artifact of ["root", "source", "manifest"] as const) {
        const { tempRoot, rootDir, stateDir, env, config } = configuredRegistry(true);
        writeRegistryPackagePlugin(rootDir);
        await writePersistedInstalledPluginIndex(loadInstalledPluginIndex({ config, env }), {
          stateDir,
        });
        const artifactPath =
          artifact === "root"
            ? rootDir
            : path.join(rootDir, artifact === "source" ? "index.ts" : "openclaw.plugin.json");
        fs.rmSync(artifactPath, { recursive: artifact === "root" });
        fs.symlinkSync(path.join(tempRoot, "missing"), artifactPath);

        const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

        expect([artifact, result.source]).toEqual([artifact, "derived"]);
        expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
      }
    },
  );

  it("rejects escaped missing package metadata for disabled records", async () => {
    const { stateDir, env, config, index } = packageRegistry(true);
    await persistFirstPlugin(index, stateDir, {
      packageJson: { path: "../gone/package.json", hash: "missing" },
    });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectStale(result);
  });

  it("detects same-size same-mtime manifest replacements", async () => {
    const { rootDir, stateDir, env, config, index } = packageRegistry();
    await writePersistedInstalledPluginIndex(index, { stateDir });

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "demo",
        name: "Demo",
        description: "two",
        configSchema: { type: "object" },
      }),
    );

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectStale(result);
  });

  it.each([true, false])(
    "trusts an unchanged Doctor signature and rehashes legacy records (signature: %s)",
    async (signed) => {
      const fixture = signed ? bundledRegistry() : configuredRegistry();
      const rootDir =
        "rootDir" in fixture ? fixture.rootDir : path.join(fixture.bundledRoot, "demo");
      const { stateDir, env } = fixture;
      const config = "config" in fixture ? fixture.config : {};
      if (signed) {
        writeBundledPlugin(rootDir, "demo", "index.js");
      } else {
        writeRegistryPackagePlugin(rootDir);
      }
      const contractPath = path.join(rootDir, "doctor-contract-api.ts");
      fs.writeFileSync(contractPath, 'export const marker = "aaaa";\n', "utf8");
      const index = loadInstalledPluginIndex({ config, env });
      const plugin = requirePluginRecord(index.plugins, "demo");
      expect(plugin.doctorContractFile).toEqual(fileSignature(contractPath));
      await persistFirstPlugin(index, stateDir, {
        doctorContractHash: "stale-contract-hash",
        ...(!signed ? { doctorContractFile: undefined } : {}),
      });

      const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

      if (signed) {
        expect(result.source).toBe("persisted");
        expect(result.snapshot.plugins[0]?.doctorContractHash).toBe("stale-contract-hash");
      } else {
        expectStale(result);
        expect(result.snapshot.plugins[0]?.doctorContractHash).not.toBe("stale-contract-hash");
      }
    },
  );

  it("detects package.json replacements even when stored stat fields still match", async () => {
    const { rootDir, stateDir, env, config, index } = packageRegistry();

    replaceFilePreservingSizeAndMtime(
      path.join(rootDir, "package.json"),
      JSON.stringify({ name: "demo", version: "1.0.1" }),
    );
    const stat = fs.statSync(path.join(rootDir, "package.json"));
    const [plugin] = index.plugins;
    if (!plugin?.packageJson) {
      throw new Error("expected test plugin package metadata");
    }
    const stalePlugin = {
      ...plugin,
      packageJson: {
        ...plugin.packageJson,
        fileSignature: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
      },
    };
    const staleIndex: InstalledPluginIndex = {
      ...index,
      plugins: [stalePlugin, ...index.plugins.slice(1)],
    };
    await writePersistedInstalledPluginIndex(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectStale(result);
  });

  it("keeps mixed source-checkout bundled roots from the same checkout", async () => {
    const { packageRoot, bundledRoot, sourceRoot, stateDir, env } = bundledRegistry();

    writeCheckout(packageRoot);
    writeBundledPlugin(path.join(bundledRoot, "codex"), "codex", "index.js", {
      bundledDist: true,
      openclawVersion: "2026.4.26",
      pluginSdkVersion: "2026.4.26",
    });
    writeBundledPlugin(path.join(sourceRoot, "whatsapp"), "whatsapp", "index.ts", {
      openclawVersion: "2026.4.26",
    });

    const index = loadInstalledPluginIndex({ config: {}, env, stateDir });
    expect(index.plugins.map((plugin) => plugin.pluginId)).toEqual(["codex", "whatsapp"]);
    expect(index.plugins.map((plugin) => plugin.rootDir)).toEqual([
      fs.realpathSync(path.join(bundledRoot, "codex")),
      fs.realpathSync(path.join(sourceRoot, "whatsapp")),
    ]);
    expect(requirePluginRecord(index.plugins, "codex").packageBuild).toEqual({
      bundledDist: true,
      openclawVersion: "2026.4.26",
      pluginSdkVersion: "2026.4.26",
    });
    expect(requirePluginRecord(index.plugins, "whatsapp").packageBuild).toEqual({
      openclawVersion: "2026.4.26",
    });
    await writePersistedInstalledPluginIndex(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config: {}, env, stateDir });

    expectPersisted(result);
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["codex", "whatsapp"]);
    expect(requirePluginRecord(result.snapshot.plugins, "codex").packageBuild).toEqual({
      bundledDist: true,
    });
    expect(requirePluginRecord(result.snapshot.plugins, "whatsapp").packageBuild).toEqual({});
  });

  it("keeps missing disabled bundled records under the trusted bundled root", async () => {
    const { pluginRoot, stateDir, env, config } = disabledBundledRegistry();
    const index = loadInstalledPluginIndex({ config, env, stateDir });
    const persistedPlugin = requirePluginRecord(index.plugins, "whatsapp");
    expect(persistedPlugin.doctorContractHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persistedPlugin.doctorContractFile).toBeDefined();
    await writePersistedInstalledPluginIndex(index, { stateDir });
    fs.rmSync(pluginRoot, { recursive: true });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectPersisted(result);
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["whatsapp"]);
    expect(result.snapshot.plugins[0]?.enabled).toBe(false);
    expect(result.snapshot.plugins[0]?.doctorContractHash).toBe(persistedPlugin.doctorContractHash);
  });

  it("invalidates disabled installed records when their Doctor contract disappears", async () => {
    const { contractPath, stateDir, env, config } = disabledBundledRegistry();
    const index = loadInstalledPluginIndex({ config, env, stateDir });
    await writePersistedInstalledPluginIndex(index, { stateDir });
    fs.rmSync(contractPath);

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expectStale(result);
  });

  it("keeps missing disabled inventory beside unchanged configured plugins", async () => {
    const { tempRoot, stateDir, env } = isolatedRegistry();
    const liveRoot = path.join(tempRoot, "live");
    const missingRoot = path.join(tempRoot, "missing");
    const config = {
      plugins: {
        load: { paths: [liveRoot, missingRoot] },
        entries: { missing: { enabled: false } },
      },
    };
    writeRegistryPackagePlugin(liveRoot, { pluginId: "live" });
    writeRegistryPackagePlugin(missingRoot, { pluginId: "missing" });
    const index = loadInstalledPluginIndex({ config, env });
    await writePersistedInstalledPluginIndex(index, { stateDir });
    fs.rmSync(missingRoot, { recursive: true });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.plugins.map((plugin) => plugin.pluginId)).toEqual(["live", "missing"]);
    expect(requirePluginRecord(result.snapshot.plugins, "missing").enabled).toBe(false);
  });

  it.each(["built peer appears", "source opts out", "source mounted"] as const)(
    "reselects the persisted bundled owner when %s",
    async (change) => {
      const { packageRoot, bundledRoot, sourceRoot, stateDir, env } = bundledRegistry();
      const source = path.join(sourceRoot, "whatsapp");
      const built = path.join(bundledRoot, "whatsapp");
      writeCheckout(packageRoot);
      fs.mkdirSync(bundledRoot, { recursive: true });
      writeBundledPlugin(source, "whatsapp", "index.ts");
      if (change === "source opts out") {
        writeBundledPlugin(built, "whatsapp", "index.js");
      }
      const params = { config: {}, env, stateDir };
      const index = loadInstalledPluginIndex(params);
      expect(index.plugins.map((plugin) => plugin.rootDir)).toEqual([
        fs.realpathSync(change === "source opts out" ? built : source),
      ]);
      await writePersistedInstalledPluginIndex(index, { stateDir });
      if (change === "source opts out") {
        writeJson(path.join(source, "package.json"), {
          name: "@openclaw/whatsapp",
          version: "1.0.0",
          openclaw: { extensions: ["./index.ts"], build: { bundledDist: false } },
        });
      } else {
        writeBundledPlugin(built, "whatsapp", "index.js");
        if (change === "source mounted") {
          mockLinuxMountInfo([source]);
        }
      }
      const result = loadPluginRegistrySnapshotWithMetadata(params);
      if (change === "source mounted") {
        expectPersisted(result);
      } else {
        expectStale(result);
      }
      expect(result.snapshot.plugins.map((plugin) => plugin.rootDir)).toEqual([
        fs.realpathSync(change === "built peer appears" ? built : source),
      ]);
    },
  );

  it.each(["plugin", "parent", "disabled"] as const)(
    "respects %s source mounts after restarting with a persisted built registry",
    async (mount) => {
      const { tempRoot, bundledRoot, sourceRoot, stateDir, env } = bundledRegistry();
      const builtPluginDir = path.join(bundledRoot, "demo");
      const sourcePluginDir = path.join(sourceRoot, "demo");
      const workspaceDir = path.join(tempRoot, "workspace");
      if (mount === "disabled") {
        env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS = "1";
      }
      const config = { plugins: { entries: { demo: { enabled: true } } } };
      writeBundledPlugin(builtPluginDir, "demo", "index.js");
      writeBundledPlugin(sourcePluginDir, "demo", "index.ts");
      const index = loadInstalledPluginIndex({ config, env, stateDir, workspaceDir });
      expect(index.plugins.map((plugin) => plugin.rootDir)).toEqual([
        fs.realpathSync(builtPluginDir),
      ]);
      await writePersistedInstalledPluginIndex(index, { stateDir });
      clearPluginMetadataLifecycleCaches();
      mockLinuxMountInfo([mount === "parent" ? sourceRoot : sourcePluginDir]);

      const result = loadPluginRegistrySnapshotWithMetadata({
        config,
        env,
        stateDir,
        workspaceDir,
      });

      expect(result.source).toBe(mount === "disabled" ? "persisted" : "derived");
      expect(result.snapshot.plugins.map((plugin) => plugin.rootDir)).toEqual([
        fs.realpathSync(mount === "disabled" ? builtPluginDir : sourcePluginDir),
      ]);
    },
  );

  it("treats persisted registry as stale when a plugin diagnostic source path no longer exists", async () => {
    const { tempRoot, stateDir, env } = isolatedRegistry();
    const config = {};
    const ghostDir = path.join(tempRoot, "extensions", "lossless-claw");
    const npmPluginDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@martian-engineering/lossless-claw",
      pluginId: "lossless-claw",
      version: "0.9.4",
    });
    const staleIndex: InstalledPluginIndex = {
      ...loadInstalledPluginIndex({ config, env, stateDir, installRecords: {} }),
      diagnostics: [
        {
          level: "warn",
          message:
            "installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ./dist/index.js",
          pluginId: "lossless-claw",
          source: ghostDir,
        },
      ],
    };
    await writePersistedInstalledPluginIndex(staleIndex, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("derived");
    expect(result.snapshot.diagnostics.map((diagnostic) => diagnostic.source)).not.toContain(
      ghostDir,
    );
    const losslessPlugin = requirePluginRecord(result.snapshot.plugins, "lossless-claw");
    expect(losslessPlugin.origin).toBe("global");
    expect(losslessPlugin.source).toBe(
      fs.realpathSync(path.join(npmPluginDir, "dist", "index.js")),
    );
    expectDiagnosticsContainCode(result.diagnostics, "persisted-registry-stale-source");
  });

  it("keeps persisted registry when a non-plugin diagnostic source path still does not exist", async () => {
    const { tempRoot, stateDir, env } = isolatedRegistry();
    const config = {};
    const missingConfiguredPath = path.join(tempRoot, "missing-configured-plugin");
    const index: InstalledPluginIndex = {
      ...loadInstalledPluginIndex({ config, env, stateDir, installRecords: {} }),
      diagnostics: [
        {
          level: "error",
          message: `plugin path not found: ${missingConfiguredPath}`,
          source: missingConfiguredPath,
        },
      ],
    };
    await writePersistedInstalledPluginIndex(index, { stateDir });

    const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

    expect(result.source).toBe("persisted");
    expect(result.snapshot.diagnostics.map((diagnostic) => diagnostic.source)).toContain(
      missingConfiguredPath,
    );
    expect(result.diagnostics).toStrictEqual([]);
  });
});
it("checks shared persisted files once per fleet while discovering every workspace and refreshing the next operation", async () => {
  const root = makeTempDir();
  const bundled = path.join(root, "bundled");
  const sharedRoot = path.join(bundled, "shared");
  fs.mkdirSync(sharedRoot, { recursive: true });
  const shared = createColdPluginFixture({ rootDir: sharedRoot, pluginId: "shared" });
  const workspaces = Array.from({ length: 6 }, (_, index) => path.join(root, `agent-${index}`));
  for (const [index, workspace] of workspaces.entries()) {
    const localRoot = path.join(workspace, ".openclaw", "extensions", `local-${index}`);
    fs.mkdirSync(localRoot, { recursive: true });
    createColdPluginFixture({ rootDir: localRoot, pluginId: `local-${index}` });
  }
  const env = {
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_VERSION: "2026.4.26",
    VITEST: "true",
  };
  const configFor = (count: number) => ({
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        workspaces.slice(0, count).map((workspace, index) => [`agent-${index}`, { workspace }]),
      ),
    },
  });
  await writePersistedInstalledPluginIndex(
    loadInstalledPluginIndex({ config: configFor(3), env, workspaceDir: workspaces[0] }),
    { env },
  );
  const manifestPath = path.join(sharedRoot, "openclaw.plugin.json");
  const readFleet = (count: number) => {
    const inspectPath = vi.spyOn(fs, "lstatSync");
    try {
      const snapshot = resolveConfigWidePluginMetadataSnapshot({
        config: configFor(count),
        env,
        allowCurrent: false,
      });
      expect(snapshot.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
        ["shared", ...workspaces.slice(0, count).map((_, index) => `local-${index}`)].toSorted(),
      );
      expect(snapshot.registryIndex.workspaceDir).toBe(workspaces[0]);
      expect(snapshot.plugins.find((plugin) => plugin.id === `local-${count - 1}`)?.source).toBe(
        path.join(
          root,
          `agent-${count - 1}`,
          ".openclaw",
          "extensions",
          `local-${count - 1}`,
          "index.cjs",
        ),
      );
      return {
        snapshot,
        sharedFileChecks: inspectPath.mock.calls.filter(([target]) => target === manifestPath)
          .length,
      };
    } finally {
      inspectPath.mockRestore();
    }
  };
  const small = readFleet(3);
  const large = readFleet(6);
  expect(small.sharedFileChecks).toBeGreaterThan(0);
  expect(large.sharedFileChecks).toBe(small.sharedFileChecks);

  writeJson(manifestPath, {
    id: "shared",
    name: "Updated fleet plugin",
    configSchema: { type: "object" },
  });
  expect(readFleet(6).snapshot.byPluginId.get("shared")?.name).toBe("Updated fleet plugin");
  expect(large.snapshot.byPluginId.get("shared")?.name).toBe("Cold Control Plane");
  expect(fs.existsSync(shared.runtimeMarker)).toBe(false);
});

it("keeps persisted package plugins when file hashes match", async () => {
  const { rootDir, stateDir, env, config } = configuredRegistry();
  writeRegistryPackagePlugin(rootDir);
  const index = loadInstalledPluginIndex({ config, env });
  const [record] = index.plugins;
  if (!record?.packageJson?.fileSignature || !record.manifestFile) {
    throw new Error("expected package plugin index record with file signatures");
  }
  expect(record.manifestFile.size).toBe(
    fs.statSync(path.join(rootDir, "openclaw.plugin.json")).size,
  );
  expect(record.packageJson.fileSignature.size).toBe(
    fs.statSync(path.join(rootDir, "package.json")).size,
  );
  record.sourceAdmissions = {
    [`${rootDir}\0`]: {
      signature: "unchanged-source-inputs",
      sourceDigest: "a".repeat(64),
      nativeArtifacts: {},
      nativeNamespaces: {},
    },
  };
  await writePersistedInstalledPluginIndex(index, { stateDir });

  const result = loadPluginRegistrySnapshotWithMetadata({ config, env, stateDir });

  expect(result.source).toBe("persisted");
  expect(result.diagnostics).toStrictEqual([]);
  expect(result.snapshot.plugins[0]?.sourceAdmissions).toEqual(record.sourceAdmissions);
});
