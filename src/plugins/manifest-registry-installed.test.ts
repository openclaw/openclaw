// Covers installed plugin manifest registry behavior.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import {
  loadPluginManifestRegistryForInstalledIndex,
  resolveInstalledManifestRegistryIndexFingerprint,
} from "./manifest-registry-installed.js";
import { createIndex } from "./manifest-registry-installed.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-manifest-registry", tempDirs);
}

function writePlugin(rootDir: string, pluginId: string, modelPrefix: string) {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while reading manifests');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object" },
      providers: [pluginId],
      modelSupport: {
        modelPrefixes: [modelPrefix],
      },
    }),
    "utf8",
  );
}

function installedFixture() {
  const rootDir = makeTempDir();
  writePlugin(rootDir, "installed", "installed-");
  return { rootDir, index: createIndex(rootDir) };
}

function packageIndex(rootDir: string, packagePath = "package.json") {
  const index = createIndex(rootDir);
  expectDefined(index.plugins[0], "installed fixture record").packageJson = {
    path: packagePath,
    hash: "old-index-hash",
  };
  return index;
}

function writeChannelPackage(rootDir: string, channel: object, packagePath = "package.json") {
  const target = path.join(rootDir, packagePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ openclaw: { channel } }), "utf8");
}

function fileSignature(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function createIndexWithFileSignatures(rootDir: string): InstalledPluginIndex {
  const index = createIndex(rootDir);
  return {
    ...index,
    plugins: index.plugins.map((record) => {
      record.manifestFile = fileSignature(record.manifestPath);
      return record;
    }),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function writePackageManifest(rootDir: string, channelLabel: string, selectionDocsPrefix?: string) {
  const packageJsonPath = path.join(rootDir, "package.json");
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify({
      name: "@openclaw/installed",
      version: "1.0.0",
      dependencies: {
        "runtime-dep": "1.0.0",
      },
      openclaw: {
        channel: {
          id: "installed",
          label: channelLabel,
          ...(selectionDocsPrefix !== undefined ? { selectionDocsPrefix } : {}),
        },
      },
    }),
    "utf8",
  );
  return packageJsonPath;
}

function createIndexWithPackageJson(
  rootDir: string,
  selectionDocsPrefix?: string,
): InstalledPluginIndex {
  const index = createIndexWithFileSignatures(rootDir);
  const packageJsonPath = writePackageManifest(rootDir, "Installed", selectionDocsPrefix);
  const record = index.plugins[0];
  if (!record) {
    throw new Error("expected index record");
  }
  record.packageJson = {
    path: "package.json",
    hash: "package-json-hash",
    fileSignature: fileSignature(packageJsonPath),
  };
  return {
    ...index,
    plugins: [record],
  };
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  it.each([undefined, "plugin-state"])(
    "preserves known backing-store metadata %s through installed records",
    (backingStore) => {
      const root = makeTempDir();
      writePlugin(root, "installed", "installed/");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "@openclaw/installed",
          version: "1.0.0",
          openclaw: {
            channel: {
              id: "installed",
              persistedAuthState: {
                specifier: "./auth-presence",
                exportName: "hasAuth",
                exportNameAsync: "hasAuthAsync",
                backingStore,
              },
            },
          },
        }),
      );
      const index = createIndex(root);
      expectDefined(index.plugins[0], "installed fixture record").packageJson = {
        path: "package.json",
        hash: "fixture-package-metadata",
      };
      const registry = loadPluginManifestRegistryForInstalledIndex({
        index,
        env: { VITEST: "true" },
        includeDisabled: true,
      });
      expect(registry.plugins[0]?.packageChannel?.persistedAuthState).toEqual({
        specifier: "./auth-presence",
        exportName: "hasAuth",
        exportNameAsync: "hasAuthAsync",
        ...(backingStore === "plugin-state" ? { backingStore: "plugin-state" } : {}),
      });
    },
  );

  it("loadPluginManifestRegistryForInstalledIndex preserves account-key policy after index persistence", async () => {
    const rootDir = makeTempDir();
    const stateDir = makeTempDir();
    const policy = { canonicalAliasesRequireOwnField: "account" };
    writePlugin(rootDir, "installed", "installed-");
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "installed",
        configSchema: { type: "object" },
        channels: ["selected"],
        channelAccountKeyPolicies: { selected: policy, foreign: policy },
      }),
    );
    await writePersistedInstalledPluginIndex(createIndex(rootDir), { stateDir });
    const index = expectDefined(
      await readPersistedInstalledPluginIndex({ stateDir }),
      "persisted installed plugin index",
    );
    const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({ index });
    expect(manifestRegistry.plugins[0]?.channelAccountKeyPolicies).toEqual({ selected: policy });
  });

  const loadRegistry = (index: InstalledPluginIndex) =>
    loadPluginManifestRegistryForInstalledIndex({
      index,
      env: {
        OPENCLAW_VERSION: "2026.4.25",
        VITEST: "true",
      },
      includeDisabled: true,
    });

  it("keeps frozen installed-index fingerprints process-stable without file signatures", () => {
    const { rootDir } = installedFixture();
    const index = deepFreeze(createIndex(rootDir));
    const first = resolveInstalledManifestRegistryIndexFingerprint(index);

    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    const nextMtime = new Date(Date.now() + 5000);
    fs.utimesSync(manifestPath, nextMtime, nextMtime);
    const second = resolveInstalledManifestRegistryIndexFingerprint(index);

    expect(second).toBe(first);
  });

  it("reuses installed package metadata until plugin metadata caches are cleared", () => {
    const { rootDir } = installedFixture();
    const index = createIndexWithPackageJson(rootDir);
    const first = loadRegistry(index);
    writePackageManifest(rootDir, "Updated");
    const second = loadRegistry(index);
    clearPluginMetadataLifecycleCaches();
    const third = loadRegistry(index);

    expect(first.plugins[0]?.packageChannel?.label).toBe("Installed");
    expect(second.plugins[0]?.packageChannel?.label).toBe("Installed");
    expect(third.plugins[0]?.packageChannel?.label).toBe("Updated");
    expect(third.plugins[0]?.packageDependencies).toEqual({
      "runtime-dep": "1.0.0",
    });
  });

  it("preserves empty docs prefixes from package channel metadata", () => {
    const { rootDir } = installedFixture();

    const registry = loadRegistry(createIndexWithPackageJson(rootDir, ""));

    expect(registry.plugins[0]?.packageChannel?.selectionDocsPrefix).toBe("");
  });

  it("reuses a prepared manifest graph without reopening plugin manifests", () => {
    const { rootDir, index } = installedFixture();
    const env = { OPENCLAW_VERSION: "2026.4.25", VITEST: "true" };
    const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      includeDisabled: true,
    });
    fs.unlinkSync(path.join(rootDir, "openclaw.plugin.json"));

    const reused = loadPluginManifestRegistryForInstalledIndex({
      index,
      env,
      manifestRegistry,
      includeDisabled: true,
    });

    expect(reused.plugins).toEqual(manifestRegistry.plugins);
    expect(reused.diagnostics).toEqual([]);
  });

  it("hydrates package metadata while dropping setup fields with mismatched CLI names", () => {
    const { rootDir } = installedFixture();
    writeChannelPackage(rootDir, {
      id: "installed",
      label: "Installed",
      approvalFlags: ["native", "unsupported"],
      commands: {
        nativeCommandsAutoEnabled: true,
        nativeSkillsAutoEnabled: false,
      },
      setup: {
        fields: [
          {
            key: "tenant",
            kind: "choice",
            choices: ["alpha", "beta"],
            cli: {
              flags: "--tenant <tenant>",
              negatedFlags: "--no-tenant",
              description: "Installed tenant",
            },
          },
          {
            key: "credential",
            kind: "string",
            cli: {
              flags: "--token <value>",
              description: "Installed credential",
            },
          },
          {
            key: "tenant",
            kind: "boolean",
            cli: {
              flags: "--tenant",
              negatedFlags: "--no-other",
              description: "Mismatched tenant toggle",
            },
          },
          {
            key: "useEnv",
            kind: "boolean",
            envVars: ["INSTALLED_TOKEN", "INSTALLED_TOKEN_FILE"],
            envVarMode: "any",
            cli: {
              flags: "--use-env",
              negatedFlags: "--no-use-env",
              description: "Use environment credentials",
            },
          },
        ],
      },
    });
    const index = packageIndex(rootDir);
    expectDefined(index.plugins[0], "installed fixture record").packageChannel = {
      id: "installed",
      label: "Installed",
    };
    const registry = loadRegistry(index);

    expect(registry.plugins[0]?.channelCatalogMeta?.commands).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
    expect(registry.plugins[0]?.packageChannel?.approvalFlags).toEqual(["native"]);
    expect(registry.plugins[0]?.packageManifest?.channel?.setup).toEqual({
      fields: [
        {
          key: "tenant",
          kind: "choice",
          choices: ["alpha", "beta"],
          cli: {
            flags: "--tenant <tenant>",
            negatedFlags: "--no-tenant",
            description: "Installed tenant",
          },
        },
        {
          key: "useEnv",
          kind: "boolean",
          envVars: ["INSTALLED_TOKEN", "INSTALLED_TOKEN_FILE"],
          envVarMode: "any",
          cli: {
            flags: "--use-env",
            negatedFlags: "--no-use-env",
            description: "Use environment credentials",
          },
        },
      ],
    });
  });

  it("hydrates package metadata from dot-prefixed package directories", () => {
    const { rootDir } = installedFixture();
    writeChannelPackage(
      rootDir,
      {
        id: "installed",
        label: "Installed",
        commands: { nativeCommandsAutoEnabled: true, nativeSkillsAutoEnabled: false },
      },
      "..meta/package.json",
    );
    const registry = loadRegistry(packageIndex(rootDir, "..meta/package.json"));

    expect(registry.plugins[0]?.channelCatalogMeta?.commands).toEqual({
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: false,
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not hydrate package metadata through a symlink outside the plugin root",
    () => {
      const rootDir = makeTempDir();
      const outsideDir = makeTempDir();
      const packageJsonPath = path.join(rootDir, "package.json");
      const outsidePackageJsonPath = path.join(outsideDir, "package.json");
      writePlugin(rootDir, "installed", "installed-");
      writeChannelPackage(outsideDir, {
        id: "installed",
        label: "Installed",
        commands: { nativeCommandsAutoEnabled: true, nativeSkillsAutoEnabled: false },
      });
      fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);
      const registry = loadRegistry(packageIndex(rootDir));

      expect(registry.plugins[0]?.channelCatalogMeta?.commands).toBeUndefined();
    },
  );

  it("ignores malformed persisted package channel metadata", () => {
    const { index } = installedFixture();
    const persistedRecord = {
      ...expectDefined(index.plugins[0], "installed fixture record"),
      packageChannel: {
        id: ["installed"],
        label: 12,
        blurb: { text: "bad" },
        preferOver: "legacy",
        commands: {
          nativeCommandsAutoEnabled: "yes",
        },
      },
    };
    const registry = loadRegistry({
      ...index,
      plugins: [persistedRecord],
    } as unknown as InstalledPluginIndex);

    expect(registry.plugins[0]?.packageManifest).toBeUndefined();
    expect(registry.plugins[0]?.channelCatalogMeta).toBeUndefined();
  });

  it("normalizes persisted channel CLI option value types", () => {
    const { index } = installedFixture();
    const persistedRecord = {
      ...expectDefined(index.plugins[0], "installed fixture record"),
      packageChannel: {
        id: "installed",
        cliAddOptions: [
          {
            flags: "--limit <n>",
            description: "Limit",
            valueType: "int",
          },
          {
            flags: "--ignored <value>",
            description: "Ignored",
            valueType: "string",
          },
        ],
      },
    };
    const registry = loadRegistry({
      ...index,
      plugins: [persistedRecord],
    } as unknown as InstalledPluginIndex);

    expect(registry.plugins[0]?.packageChannel?.cliAddOptions).toEqual([
      { flags: "--limit <n>", description: "Limit", valueType: "int" },
      { flags: "--ignored <value>", description: "Ignored" },
    ]);
  });

  it("normalizes the open-DM wildcard doctor capability from persisted metadata", () => {
    const { index } = installedFixture();
    Object.assign(expectDefined(index.plugins[0], "installed fixture record"), {
      packageChannel: {
        id: "installed",
        doctorCapabilities: {
          openDmRequiresAllowFromWildcard: false,
        },
      },
    });
    const registry = loadRegistry(index);

    expect(
      registry.plugins[0]?.packageChannel?.doctorCapabilities?.openDmRequiresAllowFromWildcard,
    ).toBe(false);
  });

  it("round-trips bundle metadata through the persisted index before reconstruction", async () => {
    const stateDir = makeTempDir();
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "Claude Bundle",
        commands: "commands",
      }),
      "utf8",
    );

    const index = createIndex(rootDir);
    const persistedPlugin = {
      ...expectDefined(index.plugins[0], "index.plugins[0] test invariant"),
      pluginId: "claude-bundle",
      manifestPath: path.join(rootDir, ".claude-plugin", "plugin.json"),
      source: rootDir,
      format: "bundle" as const,
      bundleFormat: "claude" as const,
      setupSource: path.join(rootDir, "setup-api.js"),
    };
    await writePersistedInstalledPluginIndex(
      {
        ...index,
        plugins: [persistedPlugin],
      },
      { stateDir },
    );

    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    if (!persisted) {
      throw new Error("expected persisted installed plugin index");
    }
    expect(persisted.plugins[0]).toEqual(persistedPlugin);

    const registry = loadRegistry(persisted);

    expect(registry.diagnostics).toStrictEqual([]);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.id).toBe("claude-bundle");
    expect(registry.plugins[0]?.format).toBe("bundle");
    expect(registry.plugins[0]?.bundleFormat).toBe("claude");
    expect(registry.plugins[0]?.rootDir).toBe(rootDir);
    expect(registry.plugins[0]?.skills).toEqual(["commands"]);
  });
});
