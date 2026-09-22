import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createThemeDefinitionFixture } from "../../test/helpers/theme-fixture.js";
import { loadManifestThemeDefinitions } from "./manifest-theme-definitions.js";
import { normalizeManifestThemes } from "./manifest-themes.js";
import type { PluginDiagnostic, PluginManifestTheme } from "./manifest-types.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PLUGIN_ACTIVITY_ICON_MAX_BYTES } from "./portable-icon-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const definition = createThemeDefinitionFixture({ avatarHat: "beret", critters: ["ferris"] });
const declaration: PluginManifestTheme = {
  id: "redhat",
  name: definition.name,
  description: definition.description,
  source: "theme.json",
  hats: { beret: "beret.svg" },
  critters: { ferris: { source: "ferris.svg", title: "a crab, allegedly", crossMs: 15000 } },
};

function fixture() {
  const rootDir = tempDirs.make("openclaw-theme-artwork-");
  fs.writeFileSync(path.join(rootDir, "theme.json"), JSON.stringify(definition));
  fs.writeFileSync(path.join(rootDir, "beret.svg"), SVG);
  fs.writeFileSync(path.join(rootDir, "ferris.svg"), SVG);
  const capture = (rejectHardlinks = true) => {
    const diagnostics: PluginDiagnostic[] = [];
    const themes = withPluginCache(createPluginCache(), () =>
      loadManifestThemeDefinitions({
        pluginId: "theme-pack",
        rootDir,
        themes: [declaration],
        rejectHardlinks,
        diagnostics,
      }),
    );
    return { themes, diagnostics };
  };
  return { rootDir, capture };
}

describe("manifest theme artwork", () => {
  it("normalizes package-relative paths and preserves presentation metadata", () => {
    expect(
      normalizeManifestThemes(
        [
          {
            ...declaration,
            hats: { beret: "./assets/beret.svg" },
            critters: { ferris: { source: "./assets/ferris.svg", title: "a crab", crossMs: 5000 } },
          },
        ],
        "theme-pack",
      ),
    ).toEqual({
      ok: true,
      themes: [
        {
          ...declaration,
          hats: { beret: "assets/beret.svg" },
          critters: { ferris: { source: "assets/ferris.svg", title: "a crab", crossMs: 5000 } },
        },
      ],
    });
  });

  it.each([
    { hats: [] },
    { critters: null },
    { hats: { Beret: "beret.svg" } },
    { hats: { ["a".repeat(33)]: "beret.svg" } },
    { hats: { "": "beret.svg" } },
    { hats: { "hat.svg": "beret.svg" } },
    { hats: { fedora: "beret.svg" } },
    { hats: { crown: "beret.svg" } },
    { hats: { santa: "beret.svg" } },
    { hats: { party: "beret.svg" } },
    { hats: { pumpkin: "beret.svg" } },
    { critters: { penguin: { source: "ferris.svg" } } },
    { critters: { fedora: { source: "ferris.svg" } } },
    { critters: { Ferris: { source: "ferris.svg" } } },
    { critters: { ferris: "ferris.svg" } },
    { critters: { ferris: { source: "ferris.svg", extra: true } } },
    { hats: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`hat-${i}`, "beret.svg"])) },
    {
      critters: Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`critter-${i}`, { source: "ferris.svg" }]),
      ),
    },
  ])("rejects invalid IDs, catalog collisions, and declaration limits: %j", (artwork) => {
    expect(normalizeManifestThemes([{ ...declaration, ...artwork }], "theme-pack")).toMatchObject({
      ok: false,
    });
  });

  it.each([
    "../beret.svg",
    "/beret.svg",
    "assets/../../beret.svg",
    "assets\\beret.svg",
    "assets//beret.svg",
    "https://example.invalid/beret.svg",
    "beret.png",
    "beret.svg?hash=1",
  ])("rejects unsafe or non-SVG artwork paths: %s", (source) => {
    for (const artwork of [{ hats: { beret: source } }, { critters: { ferris: { source } } }]) {
      expect(normalizeManifestThemes([{ ...declaration, ...artwork }], "theme-pack")).toMatchObject(
        {
          ok: false,
          error: expect.stringContaining("SVG file inside the plugin root"),
        },
      );
    }
  });

  it.each([4999, 90001, 12000.5, "12000", null])("rejects invalid crossing time %j", (crossMs) => {
    expect(
      normalizeManifestThemes(
        [
          {
            ...declaration,
            critters: { ferris: { source: "ferris.svg", crossMs } },
          },
        ],
        "theme-pack",
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("crossMs") });
  });

  it.each(["a".repeat(61), "hello\nworld", "hello\u007f", "hello\u0085", "hello\u202e", 12])(
    "rejects nonprintable or oversized title %j",
    (title) => {
      expect(
        normalizeManifestThemes(
          [
            {
              ...declaration,
              critters: { ferris: { source: "ferris.svg", title } },
            },
          ],
          "theme-pack",
        ),
      ).toMatchObject({ ok: false, error: expect.stringContaining("title") });
    },
  );

  it("accepts the entry, ID, title, and crossing-time boundaries", () => {
    const hats = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`${i}${"a".repeat(31)}`, "hat.svg"]),
    );
    const critters = Object.fromEntries(
      Object.keys(hats).map((id) => [
        id,
        { source: "critter.svg", title: "a".repeat(60), crossMs: 90000 },
      ]),
    );
    expect(normalizeManifestThemes([{ ...declaration, hats, critters }], "theme-pack")).toEqual({
      ok: true,
      themes: [{ ...declaration, hats, critters }],
    });
  });

  it.each([
    '"hats":{"beret":"beret.svg","b\\u0065ret":"other.svg"}',
    '"critters":{"ferris":{"source":"ferris.svg"},"ferris":{"source":"other.svg"}}',
    "hats: {beret: 'beret.svg', beret: 'other.svg'}",
  ])("rejects duplicate artwork keys before JSON parsing can hide them: %s", (artwork) => {
    const rootDir = tempDirs.make("openclaw-theme-duplicate-");
    const base = JSON.stringify({ ...declaration, hats: undefined, critters: undefined }).slice(
      0,
      -1,
    );
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      `{"id":"theme-pack","configSchema":{},"themes":[${base},${artwork}}]}`,
    );
    expect(withPluginCache(createPluginCache(), () => loadPluginManifest(rootDir))).toMatchObject({
      ok: false,
      error: expect.stringContaining("duplicate artwork ID"),
    });
  });

  it("retains captured bytes after disk changes and captures replacements in the next generation", () => {
    const plugin = fixture();
    const before = plugin.capture();
    expect(before.diagnostics).toEqual([]);
    expect(before.themes?.[0]).toEqual({
      id: "redhat",
      definition,
      artwork: {
        hats: { beret: { svg: SVG } },
        critters: { ferris: { svg: SVG, title: "a crab, allegedly", crossMs: 15000 } },
      },
    });
    const changedSvg = SVG.replace("24v24", "12v12");
    fs.writeFileSync(path.join(plugin.rootDir, "beret.svg"), changedSvg);
    const after = plugin.capture();
    fs.unlinkSync(path.join(plugin.rootDir, "ferris.svg"));
    expect(before.themes?.[0]?.artwork?.hats?.beret?.svg).toBe(SVG);
    expect(after.themes?.[0]?.artwork?.hats?.beret?.svg).toBe(changedSvg);
    expect(after.themes?.[0]?.artwork?.critters?.ferris?.svg).toBe(SVG);
  });

  it.each([
    "not an SVG",
    '<svg><script>alert("no")</script></svg>',
    '<svg><image href="https://example.invalid/pixel"/></svg>',
    `${SVG}${" ".repeat(PLUGIN_ACTIVITY_ICON_MAX_BYTES)}`,
    null,
  ])("omits the whole theme with a warning when declared artwork is invalid: %j", (svg) => {
    const plugin = fixture();
    const file = path.join(plugin.rootDir, "ferris.svg");
    if (svg === null) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, svg);
    }
    const captured = plugin.capture();
    expect(captured.themes).toEqual([]);
    expect(captured.diagnostics).toEqual([
      expect.objectContaining({
        level: "warn",
        pluginId: "theme-pack",
        message: expect.stringContaining("artwork ferris.svg"),
      }),
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "applies source-file symlink and hardlink policy to artwork",
    () => {
      const plugin = fixture();
      const outside = tempDirs.make("openclaw-theme-artwork-outside-");
      const target = path.join(outside, "art.svg");
      const artwork = path.join(plugin.rootDir, "beret.svg");
      fs.writeFileSync(target, SVG);
      fs.unlinkSync(artwork);
      fs.symlinkSync(target, artwork);
      expect(plugin.capture().themes).toEqual([]);
      fs.unlinkSync(artwork);
      fs.linkSync(target, artwork);
      expect(plugin.capture().themes).toEqual([]);
      expect(plugin.capture(false).themes).toHaveLength(1);
    },
  );
});
