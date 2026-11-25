// Covers persisted installed package ownership and phase-local path validation.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordInstalledPluginIndexInstallOwner as withOwner,
  resolveInstalledPluginIndexInstallOwner as installOwner,
} from "./installed-plugin-index-install-owner.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex as readIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import {
  hasMissingInstalledPluginOwnerMetadata,
  createInstalledPluginOwnershipResolver as ownershipOf,
} from "./installed-plugin-package-ownership.js";
import { resolvePluginManifestInstallOwner as manifestOwner } from "./manifest-install-owner.js";
import { loadPluginManifestRegistryForInstalledIndex as loadRegistry } from "./manifest-registry-installed.js";
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

function writeJson(root: string, filename: string, value: unknown) {
  fs.writeFileSync(path.join(root, filename), JSON.stringify(value), "utf8");
}

function pathInstall(installPath: string) {
  return { source: "path" as const, sourcePath: installPath, installPath };
}

describe("loadPluginManifestRegistryForInstalledIndex", () => {
  it("preserves package entry identities through a persisted cold reload", async () => {
    const stateDir = makeTempDir();
    const packageDir = path.join(stateDir, "extensions", "pack");
    fs.mkdirSync(packageDir, { recursive: true });
    writeJson(packageDir, "package.json", {
      name: "pack",
      version: "1.0.0",
      openclaw: { extensions: ["./one.cjs", "./two.cjs"] },
    });
    writeJson(packageDir, "openclaw.plugin.json", { id: "pack", configSchema: { type: "object" } });
    for (const entry of ["one", "two"]) {
      fs.writeFileSync(
        path.join(packageDir, `${entry}.cjs`),
        `module.exports = { id: "pack/${entry}", register() {} };\n`,
        "utf8",
      );
    }
    const config = {
      plugins: { entries: { "pack/one": { enabled: true }, "pack/two": { enabled: false } } },
    };
    const env = {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    const installRecords = { pack: pathInstall(packageDir) };
    const index = loadInstalledPluginIndex({ config, env, installRecords, stateDir });

    expect(index.plugins.map((p) => [p.pluginId, installOwner(p), p.enabled])).toEqual([
      ["pack/one", "pack", true],
      ["pack/two", "pack", false],
    ]);
    await writePersistedInstalledPluginIndex(index, { stateDir });
    clearPluginMetadataLifecycleCaches();
    const persisted = expectDefined(await readIndex({ stateDir }), "persisted package index");
    const pluginIds = ["pack/one", "pack/two"];
    const expectedOwnership = { ok: true, value: { installOwner: "pack", pluginIds } };
    const persistedOwnership = ownershipOf(persisted);
    const firstOwnership = persistedOwnership.resolvePackage("pack/one");
    expect(firstOwnership).toMatchObject(expectedOwnership);
    if (!firstOwnership.ok) {
      throw new Error(firstOwnership.error);
    }
    firstOwnership.value.pluginIds.reverse();
    expect(persistedOwnership.resolvePackage("pack/two")).toMatchObject(expectedOwnership);

    const registryParams = { index: persisted, config, env };
    const allEntries = loadRegistry({ ...registryParams, includeDisabled: true });
    expect(
      allEntries.plugins.map((p) => [p.id, path.basename(p.source), manifestOwner(p)]),
    ).toEqual([
      ["pack/one", "one.cjs", "pack"],
      ["pack/two", "two.cjs", "pack"],
    ]);

    const enabledEntries = loadRegistry(registryParams);
    expect(enabledEntries.plugins.map(({ id }) => id)).toEqual(["pack/one"]);

    const ownerless = {
      ...persisted,
      plugins: persisted.plugins.map((plugin) => {
        const ownerlessPlugin = { ...plugin };
        Reflect.deleteProperty(ownerlessPlugin, "installOwner");
        Reflect.deleteProperty(ownerlessPlugin, "installOwnerAmbiguous");
        return ownerlessPlugin;
      }),
    };
    expect(ownershipOf(ownerless).resolvePackage("pack/one").ok).toBe(false);

    const orphanedOwner = {
      ...persisted,
      installRecords: {
        ...persisted.installRecords,
        orphaned: pathInstall(path.join(stateDir, "removed-orphan")),
      },
    };
    const orphanOwnership = ownershipOf(orphanedOwner);
    expect(orphanOwnership.resolvePackage("orphaned").ok).toBe(false);
    expect(orphanOwnership.resolveLifecycle("orphaned")).toMatchObject({
      ok: true,
      value: { kind: "orphan", installOwner: "orphaned", pluginIds: [] },
    });
    expect(hasMissingInstalledPluginOwnerMetadata(orphanedOwner, env)).toBe(false);

    const withAlias = (second = installRecords.pack) => ({
      ...ownerless,
      installRecords: { "pack/one": installRecords.pack, "pack/two": second },
    });
    const legacyAmbiguous = withAlias();
    const legacyOwnership = ownershipOf(legacyAmbiguous);
    expect(legacyOwnership.resolvePackage("pack/one").ok).toBe(false);
    expect(legacyOwnership.resolveLifecycle("pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(legacyAmbiguous, env)).toBe(true);

    const packageAlias = path.join(stateDir, "pack-alias");
    fs.symlinkSync(packageDir, packageAlias, process.platform === "win32" ? "junction" : "dir");
    const aliasedAmbiguous = withAlias(pathInstall(packageAlias));
    const aliasedOwnership = ownershipOf(aliasedAmbiguous);
    expect(aliasedOwnership.resolvePackage("pack/one").ok).toBe(false);
    expect(aliasedOwnership.resolveLifecycle("pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(aliasedAmbiguous, env)).toBe(true);

    const unrelatedOwner = "unrelated";
    const unrelatedPlugin = withOwner(
      {
        ...aliasedAmbiguous.plugins[0]!,
        pluginId: unrelatedOwner,
        rootDir: path.join(stateDir, unrelatedOwner),
      },
      unrelatedOwner,
    );
    const relationScoped = {
      ...aliasedAmbiguous,
      plugins: [...aliasedAmbiguous.plugins, unrelatedPlugin],
      installRecords: {
        ...aliasedAmbiguous.installRecords,
        [unrelatedOwner]: pathInstall(path.join(stateDir, unrelatedOwner)),
      },
    };
    expect(ownershipOf(relationScoped).resolvePackage(unrelatedOwner)).toMatchObject({
      ok: true,
      value: { installOwner: unrelatedOwner, pluginIds: [unrelatedOwner] },
    });

    const ambiguous = {
      ...legacyAmbiguous,
      plugins: ownerless.plugins.map((plugin) => withOwner(plugin, undefined, true)),
    };
    expect(ownershipOf(ambiguous).resolvePackage("pack/one").ok).toBe(false);
    expect(hasMissingInstalledPluginOwnerMetadata(ambiguous, env)).toBe(true);
  });

  it("rechecks replaced package paths in the next ownership phase", () => {
    const rootDir = makeTempDir();
    const alias = path.join(makeTempDir(), "package");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(makeTempDir(), alias, linkType);
    const index = createIndex(rootDir);
    withOwner(index.plugins[0]!, "installed");
    index.installRecords = {
      installed: { source: "path", installPath: rootDir },
      orphan: { source: "path", installPath: alias },
    };
    const initial = ownershipOf(index);
    expect(initial.resolvePackage("installed").ok).toBe(true);
    expect(initial.resolveLifecycle("orphan")).toMatchObject({
      ok: true,
      value: { kind: "orphan", installOwner: "orphan" },
    });

    fs.unlinkSync(alias);
    fs.symlinkSync(rootDir, alias, linkType);
    const replaced = ownershipOf(index);
    expect(replaced.resolvePackage("installed")).toMatchObject({
      ok: false,
      error: expect.stringContaining("shares package path ownership"),
    });
    expect(replaced.resolveLifecycle("orphan").ok).toBe(false);
  });
});
