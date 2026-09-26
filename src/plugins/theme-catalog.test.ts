import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeUiAppearancePreference } from "../../packages/gateway-protocol/src/schema/ui-appearance-preferences.js";
import { isThemeId } from "../../packages/gateway-protocol/src/theme-ids.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../test/helpers/theme-fixture.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { listPluginThemes, resolvePluginThemeArtwork } from "./theme-catalog.js";

vi.unmock("../version.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(themes?: unknown, id = "space") {
  const rootDir = tempDirs.make("openclaw-theme-catalog-");
  fs.chmodSync(rootDir, 0o755);
  const definition = createThemeDefinitionFixture();
  const declaration = {
    id: "neon",
    name: definition.name,
    description: definition.description,
    source: "theme.json",
  };
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object" },
      themes: themes ?? [declaration],
    }),
  );
  fs.writeFileSync(path.join(rootDir, "theme.json"), JSON.stringify(definition));
  fs.writeFileSync(
    path.join(rootDir, "index.js"),
    'throw new Error("theme discovery must not execute plugin code")',
  );
  const readRegistry = () =>
    withPluginCache(createPluginCache(), () =>
      loadPluginManifestRegistryCore({
        candidates: [
          { idHint: id, rootDir, source: path.join(rootDir, "index.js"), origin: "config" },
        ],
      }),
    );
  const readSnapshot = () => createPluginMetadataSnapshotFixture(readRegistry());
  return { id, rootDir, declaration, definition, readRegistry, readSnapshot };
}

function discoverThemePack(plugin: ReturnType<typeof fixture>, entries = ["one", "Two"]) {
  fs.writeFileSync(
    path.join(plugin.rootDir, "package.json"),
    JSON.stringify({
      name: "theme-pack-fixture",
      version: "1.0.0",
      openclaw: { extensions: entries.map((entry) => `./${entry}.cjs`) },
    }),
  );
  for (const entry of entries) {
    fs.writeFileSync(
      path.join(plugin.rootDir, `${entry}.cjs`),
      'throw new Error("theme discovery must not execute plugin code")',
    );
  }
  const env = { OPENCLAW_STATE_DIR: plugin.rootDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
  return withPluginCache(createPluginCache(), () => {
    const discovery = discoverConfiguredPluginLoadPaths({ loadPaths: [plugin.rootDir], env });
    return loadPluginManifestRegistryCore({ ...discovery, env, installRecords: {} });
  });
}

describe("manifest theme catalog", () => {
  it.each(["pack", "MixedCase", "@scope/Pack"])(
    "preserves discovered multi-entry identities from %s through catalog and profile selection",
    (id) => {
      const registry = discoverThemePack(fixture(undefined, id));
      expect(registry.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
        [`${id}/one`, `${id}/Two`].toSorted(),
      );
      const catalog = withPluginMetadataSnapshotScope(
        createPluginMetadataSnapshotFixture(registry),
        listPluginThemes,
      );
      expect(catalog.map((theme) => theme.id).toSorted()).toEqual(
        [`${id}/one/neon`, `${id}/Two/neon`].toSorted(),
      );
      for (const theme of catalog) {
        expect(isThemeId(theme.id)).toBe(true);
        expect(normalizeUiAppearancePreference("ui.theme", theme.id)).toBe(theme.id);
      }
    },
  );

  it("diagnoses an overlong derived theme ID while retaining valid sibling entry themes", () => {
    const id = "a".repeat(245);
    const registry = discoverThemePack(fixture(undefined, id), ["one", "longentry"]);
    const catalog = withPluginMetadataSnapshotScope(
      createPluginMetadataSnapshotFixture(registry),
      listPluginThemes,
    );
    expect(catalog.map((theme) => theme.id)).toEqual([`${id}/one/neon`]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: `${id}/longentry`,
        message: expect.stringContaining("qualified theme ID"),
      }),
    );
  });

  it("retains captured palettes until publication and picks up edited JSON in the next metadata generation", () => {
    const plugin = fixture();
    const before = plugin.readSnapshot();
    const readTheme = () => listPluginThemes().find((theme) => theme.id === "space/neon");
    const entry = withPluginMetadataSnapshotScope(before, readTheme);
    expect(entry).toMatchObject({
      id: "space/neon",
      source: "plugin",
      pluginId: "space",
      modes: ["dark"],
      definition: { dark: { primary: "#b3ff33" } },
    });
    fs.writeFileSync(
      path.join(plugin.rootDir, "theme.json"),
      JSON.stringify(
        createThemeDefinitionFixture({
          dark: createThemePaletteFixture({ primary: "#ff33aa" }),
          mascot: "none",
          workingPhrases: ["Building", "Compiling"],
          critters: ["penguin", "fedora"],
          avatarHat: "fedora",
        }),
      ),
    );
    expect(withPluginMetadataSnapshotScope(before, readTheme)?.definition?.dark?.primary).toBe(
      "#b3ff33",
    );
    const after = plugin.readSnapshot();
    fs.unlinkSync(path.join(plugin.rootDir, "theme.json"));
    expect(withPluginMetadataSnapshotScope(after, readTheme)).toMatchObject({
      mascot: "none",
      workingPhrases: ["Building", "Compiling"],
      critters: ["penguin", "fedora"],
      avatarHat: "fedora",
      definition: {
        mascot: "none",
        workingPhrases: ["Building", "Compiling"],
        critters: ["penguin", "fedora"],
        avatarHat: "fedora",
        dark: { primary: "#ff33aa" },
      },
    });
    expect(withPluginMetadataSnapshotScope(before, readTheme)?.definition?.dark?.primary).toBe(
      "#b3ff33",
    );
    expect(withPluginMetadataSnapshotScope(before, readTheme)).not.toHaveProperty("mascot");
    expect(withPluginMetadataSnapshotScope(before, readTheme)).not.toHaveProperty("workingPhrases");
    expect(withPluginMetadataSnapshotScope(before, readTheme)).not.toHaveProperty("critters");
    expect(withPluginMetadataSnapshotScope(before, readTheme)).not.toHaveProperty("avatarHat");
  });

  it("hides a disabled owner's themes without changing retained palette bytes", () => {
    const snapshot = fixture().readSnapshot();
    const disabled = {
      ...snapshot,
      index: {
        ...snapshot.index,
        plugins: snapshot.index.plugins.map((plugin) => ({ ...plugin, enabled: false })),
      },
    };
    expect(withPluginMetadataSnapshotScope(disabled, listPluginThemes)).toEqual([]);
    expect(withPluginMetadataSnapshotScope(snapshot, listPluginThemes)).toHaveLength(1);
  });

  it("projects captured artwork URLs and changes only the edited content revision on publication", () => {
    const plugin = fixture(undefined, "@scope/pack");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v10H0z"/></svg>';
    fs.writeFileSync(path.join(plugin.rootDir, "hat.svg"), svg);
    fs.writeFileSync(path.join(plugin.rootDir, "critter.svg"), svg);
    fs.writeFileSync(
      path.join(plugin.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object" },
        themes: [
          {
            ...plugin.declaration,
            hats: { beret: "hat.svg" },
            critters: {
              ferris: { source: "critter.svg", title: "a crab, allegedly", crossMs: 15000 },
            },
          },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(plugin.rootDir, "theme.json"),
      JSON.stringify({ ...plugin.definition, avatarHat: "beret", critters: ["ferris"] }),
    );
    const before = plugin.readSnapshot();
    const original = withPluginMetadataSnapshotScope(before, listPluginThemes)[0];
    expect(original).toMatchObject({
      avatarHat: "beret",
      critters: ["ferris"],
      artwork: {
        hats: {
          beret: {
            url: expect.stringMatching(
              /^\/__openclaw__\/plugin-theme-art\/%40scope%2Fpack\/neon\/hat\/beret\?v=[a-f0-9]{12}$/,
            ),
          },
        },
        critters: {
          ferris: {
            url: expect.stringMatching(/\/neon\/critter\/ferris\?v=[a-f0-9]{12}$/),
            title: "a crab, allegedly",
            crossMs: 15000,
          },
        },
      },
    });
    const replacement = svg.replace("h20", "h30");
    fs.writeFileSync(path.join(plugin.rootDir, "hat.svg"), replacement);
    const after = plugin.readSnapshot();
    fs.unlinkSync(path.join(plugin.rootDir, "hat.svg"));
    fs.unlinkSync(path.join(plugin.rootDir, "critter.svg"));
    const updated = withPluginMetadataSnapshotScope(after, listPluginThemes)[0];
    expect(updated?.artwork?.hats?.beret?.url).not.toBe(original?.artwork?.hats?.beret?.url);
    expect(updated?.artwork?.critters).toEqual(original?.artwork?.critters);
    expect(withPluginMetadataSnapshotScope(before, listPluginThemes)[0]).toEqual(original);
    expect(
      withPluginMetadataSnapshotScope(before, () =>
        resolvePluginThemeArtwork(plugin.id, "neon", "hat", "beret"),
      ),
    ).toBe(svg);
    expect(
      withPluginMetadataSnapshotScope(after, () =>
        resolvePluginThemeArtwork(plugin.id, "neon", "hat", "beret"),
      ),
    ).toBe(replacement);
  });

  it.each([
    "../theme.json",
    "/theme.json",
    "themes/../../theme.json",
    "themes\\theme.json",
    "https://example.invalid/theme.json",
  ])("rejects source declarations outside the portable plugin path contract: %s", (source) => {
    const definition = createThemeDefinitionFixture();
    const plugin = fixture([
      { id: "neon", name: definition.name, description: definition.description, source },
    ]);
    expect(
      withPluginCache(createPluginCache(), () => loadPluginManifest(plugin.rootDir)),
    ).toMatchObject({ ok: false, error: expect.stringContaining("themes") });
  });

  it("rejects duplicate theme identities and the imported-theme namespace", () => {
    const plugin = fixture();
    const duplicate = fixture([plugin.declaration, plugin.declaration]);
    const reserved = fixture(undefined, "user");
    const nestedReserved = fixture(undefined, "user/entry");
    for (const rootDir of [duplicate.rootDir, reserved.rootDir, nestedReserved.rootDir]) {
      expect(withPluginCache(createPluginCache(), () => loadPluginManifest(rootDir))).toMatchObject(
        { ok: false },
      );
    }
  });

  it("reports invalid files without exposing a palette or executing the plugin", () => {
    const plugin = fixture();
    fs.writeFileSync(
      path.join(plugin.rootDir, "theme.json"),
      JSON.stringify({ ...plugin.definition, name: "Different name" }),
    );
    const registry = plugin.readRegistry();
    expect(registry.plugins[0]?.themeDefinitions).toEqual([]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("must match the manifest") }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "rejects a source symlink escaping its plugin root",
    () => {
      const plugin = fixture();
      const outside = tempDirs.make("openclaw-theme-outside-");
      const source = path.join(outside, "theme.json");
      fs.writeFileSync(source, JSON.stringify(plugin.definition));
      fs.unlinkSync(path.join(plugin.rootDir, "theme.json"));
      fs.symlinkSync(source, path.join(plugin.rootDir, "theme.json"));
      expect(plugin.readRegistry().plugins[0]?.themeDefinitions).toEqual([]);
    },
  );
});
