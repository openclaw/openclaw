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
import { finalizePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { listPluginThemes, resolvePluginThemeArtwork } from "./theme-catalog.js";

vi.unmock("../version.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const noExecution = 'throw new Error("theme discovery must not execute plugin code")';

function writeJson(root: string, file: string, value: unknown) {
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));
}
const readManifest = (root: string) =>
  withPluginCache(createPluginCache(), () => loadPluginManifest(root));

type Snapshot = ReturnType<typeof createPluginMetadataSnapshotFixture>;

function catalog(snapshot: Snapshot) {
  return withPluginMetadataSnapshotScope(snapshot, listPluginThemes);
}

function artwork(
  snapshot: Snapshot,
  pluginId: string,
  kind: Parameters<typeof resolvePluginThemeArtwork>[2],
  id: string,
) {
  return withPluginMetadataSnapshotScope(snapshot, () =>
    resolvePluginThemeArtwork(pluginId, "neon", kind, id),
  );
}

function fixture(themes?: unknown, id = "space", source = "theme.json") {
  const rootDir = tempDirs.make("openclaw-theme-catalog-");
  fs.chmodSync(rootDir, 0o755);
  const definition = createThemeDefinitionFixture();
  const declaration = {
    id: "neon",
    name: definition.name,
    description: definition.description,
    source,
  };
  const writeThemes = (value: unknown = [declaration]) =>
    writeJson(rootDir, "openclaw.plugin.json", {
      id,
      configSchema: { type: "object" },
      themes: value,
    });
  writeThemes(themes ?? [declaration]);
  writeJson(rootDir, "theme.json", definition);
  fs.writeFileSync(path.join(rootDir, "index.js"), noExecution);
  const readRegistry = () =>
    withPluginCache(createPluginCache(), () =>
      loadPluginManifestRegistryCore({
        candidates: [
          { idHint: id, rootDir, source: path.join(rootDir, "index.js"), origin: "config" },
        ],
      }),
    );
  const readSnapshot = () => createPluginMetadataSnapshotFixture(readRegistry());
  return { id, rootDir, declaration, definition, readRegistry, readSnapshot, writeThemes };
}

function discoverThemePack(plugin: ReturnType<typeof fixture>, entries = ["one", "Two"]) {
  writeJson(plugin.rootDir, "package.json", {
    name: "theme-pack-fixture",
    version: "1.0.0",
    openclaw: { extensions: entries.map((entry) => `./${entry}.cjs`) },
  });
  for (const entry of entries) {
    fs.writeFileSync(path.join(plugin.rootDir, `${entry}.cjs`), noExecution);
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
      const themes = catalog(createPluginMetadataSnapshotFixture(registry));
      expect(themes.map((theme) => theme.id).toSorted()).toEqual(
        [`${id}/one/neon`, `${id}/Two/neon`].toSorted(),
      );
      for (const theme of themes) {
        expect(isThemeId(theme.id)).toBe(true);
        expect(normalizeUiAppearancePreference("ui.theme", theme.id)).toBe(theme.id);
      }
    },
  );

  it("diagnoses an overlong derived theme ID while retaining valid sibling entry themes", () => {
    const id = "a".repeat(245);
    const registry = discoverThemePack(fixture(undefined, id), ["one", "longentry"]);
    expect(catalog(createPluginMetadataSnapshotFixture(registry)).map((theme) => theme.id)).toEqual(
      [`${id}/one/neon`],
    );
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
    const readTheme = (snapshot: Snapshot) => catalog(snapshot)[0];
    expect(readTheme(before)).toMatchObject({
      id: "space/neon",
      source: "plugin",
      pluginId: "space",
      modes: ["dark"],
      definition: { dark: { primary: "#b3ff33" } },
    });
    const appearance = {
      mascot: "none" as const,
      brandName: "Mission Control",
      brandIcon: "mark",
      workingIndicator: "brand" as const,
      lobsterdex: false,
      communityLinks: false,
      workingPhrases: ["Building", "Compiling"],
      critters: ["penguin", "fedora"],
      avatarHat: "fedora",
    };
    writeJson(
      plugin.rootDir,
      "theme.json",
      createThemeDefinitionFixture({
        ...appearance,
        dark: createThemePaletteFixture({ primary: "#ff33aa" }),
      }),
    );
    expect(readTheme(before)?.definition?.dark?.primary).toBe("#b3ff33");
    const after = plugin.readSnapshot();
    fs.unlinkSync(path.join(plugin.rootDir, "theme.json"));
    expect(readTheme(after)).toMatchObject({
      ...appearance,
      definition: { ...appearance, dark: { primary: "#ff33aa" } },
    });
    expect(readTheme(before)?.definition?.dark?.primary).toBe("#b3ff33");
    for (const key of ["mascot", "workingPhrases", "critters", "avatarHat"]) {
      expect(readTheme(before)).not.toHaveProperty(key);
    }
  });

  it("projects captured artwork URLs and changes only the edited content revision on publication", () => {
    const plugin = fixture(undefined, "@scope/pack");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h20v10H0z"/></svg>';
    const webp = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
    fs.writeFileSync(path.join(plugin.rootDir, "night.webp"), webp);
    for (const name of ["hat", "icon", "critter"]) {
      fs.writeFileSync(path.join(plugin.rootDir, `${name}.svg`), svg);
    }
    plugin.writeThemes([
      {
        ...plugin.declaration,
        backgrounds: { dark: "night.webp" },
        icons: { rocket: "icon.svg" },
        hats: { beret: "hat.svg" },
        critters: {
          ferris: { source: "critter.svg", title: "a crab, allegedly", crossMs: 15000 },
        },
      },
    ]);
    writeJson(plugin.rootDir, "theme.json", {
      ...plugin.definition,
      brandIcon: "rocket",
      avatarHat: "beret",
      critters: ["ferris"],
    });
    // Publication freezes the snapshot; captured raster bytes must survive it.
    const before = finalizePluginMetadataSnapshot(plugin.readSnapshot());
    const original = catalog(before)[0];
    expect(original?.artwork?.icons?.rocket?.url).toMatch(/\/neon\/icon\/rocket\?v=[a-f0-9]{12}$/);
    expect(original?.artwork?.hats?.beret?.url).toMatch(
      /^\/__openclaw__\/plugin-theme-art\/%40scope%2Fpack\/neon\/hat\/beret\?v=[a-f0-9]{12}$/,
    );
    expect(original?.artwork?.critters?.ferris).toMatchObject({
      url: expect.stringMatching(/\/neon\/critter\/ferris\?v=[a-f0-9]{12}$/),
      title: "a crab, allegedly",
      crossMs: 15000,
    });
    expect(original?.artwork?.backgrounds?.dark?.url).toMatch(
      /^\/__openclaw__\/plugin-theme-art\/%40scope%2Fpack\/neon\/background\/dark\?v=[a-f0-9]{12}$/,
    );
    expect(artwork(before, plugin.id, "background", "dark")?.body).toEqual(webp);
    const replacement = svg.replace("h20", "h30");
    for (const name of ["hat", "icon"]) {
      fs.writeFileSync(path.join(plugin.rootDir, `${name}.svg`), replacement);
    }
    const after = plugin.readSnapshot();
    for (const name of ["hat", "icon", "critter"]) {
      fs.unlinkSync(path.join(plugin.rootDir, `${name}.svg`));
    }
    const updated = catalog(after)[0];
    expect(updated?.artwork?.icons?.rocket?.url).not.toBe(original?.artwork?.icons?.rocket?.url);
    expect(updated?.artwork?.hats?.beret?.url).not.toBe(original?.artwork?.hats?.beret?.url);
    expect(updated?.artwork?.critters).toEqual(original?.artwork?.critters);
    expect(artwork(after, plugin.id, "critter", "ferris")?.body.toString("utf8")).toBe(svg);
    expect(catalog(before)[0]).toEqual(original);
    for (const [snapshot, expected] of [
      [before, svg],
      [after, replacement],
    ] as const) {
      for (const [kind, id] of [
        ["hat", "beret"],
        ["icon", "rocket"],
      ] as const) {
        expect(artwork(snapshot, plugin.id, kind, id)?.body.toString("utf8")).toBe(expected);
      }
    }
  });

  it.each([
    "../theme.json",
    "/theme.json",
    "themes/../../theme.json",
    "themes\\theme.json",
    "https://example.invalid/theme.json",
  ])("rejects source declarations outside the portable plugin path contract: %s", (source) => {
    const plugin = fixture(undefined, "space", source);
    expect(readManifest(plugin.rootDir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("themes"),
    });
  });

  it("rejects duplicate theme identities and the imported-theme namespace", () => {
    const plugin = fixture();
    const duplicate = fixture([plugin.declaration, plugin.declaration]);
    const reserved = fixture(undefined, "user");
    const nestedReserved = fixture(undefined, "user/entry");
    for (const rootDir of [duplicate.rootDir, reserved.rootDir, nestedReserved.rootDir]) {
      expect(readManifest(rootDir)).toMatchObject({ ok: false });
    }
  });

  it("reports invalid files without exposing a palette or executing the plugin", () => {
    const plugin = fixture();
    writeJson(plugin.rootDir, "theme.json", { ...plugin.definition, name: "Different name" });
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
