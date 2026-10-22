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
import {
  PLUGIN_ACTIVITY_ICON_MAX_BYTES,
  PLUGIN_THEME_BACKGROUND_MAX_BYTES,
} from "./portable-icon-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
// 1 × 1 lossless WebP.
const WEBP = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
const definition = createThemeDefinitionFixture({
  brandIcon: "rocket",
  avatarHat: "beret",
  critters: ["ferris"],
});
const declaration: PluginManifestTheme = {
  id: "redhat",
  name: definition.name,
  description: definition.description,
  source: "theme.json",
  icons: { rocket: "rocket.svg" },
  hats: { beret: "beret.svg" },
  critters: { ferris: { source: "ferris.svg", title: "a crab, allegedly", crossMs: 15000 } },
};

function fixture(theme = declaration, palette = definition) {
  const rootDir = tempDirs.make("openclaw-theme-artwork-");
  fs.writeFileSync(path.join(rootDir, "theme.json"), JSON.stringify(palette));
  for (const name of ["rocket", "beret", "ferris"]) {
    fs.writeFileSync(path.join(rootDir, `${name}.svg`), SVG);
  }
  const capture = (rejectHardlinks = true) => {
    const diagnostics: PluginDiagnostic[] = [];
    const themes = withPluginCache(createPluginCache(), () =>
      loadManifestThemeDefinitions({
        pluginId: "theme-pack",
        rootDir,
        themes: [theme],
        rejectHardlinks,
        diagnostics,
      }),
    );
    return { themes, diagnostics };
  };
  return { rootDir, capture };
}

const normalization = (artwork: Partial<PluginManifestTheme>, expected = artwork) => ({
  artwork,
  expected,
});
const entries = (prefix: string, value: unknown) =>
  Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`${prefix}-${i}`, value]));

function expectRejected(
  captured: ReturnType<ReturnType<typeof fixture>["capture"]>,
  message: string,
) {
  expect(captured).toEqual({
    themes: [],
    diagnostics: [
      expect.objectContaining({
        level: "warn",
        pluginId: "theme-pack",
        message: expect.stringContaining(message),
      }),
    ],
  });
}

describe("manifest theme artwork", () => {
  const hats = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`${i}${"a".repeat(31)}`, "hat.svg"]),
  );
  const critters = Object.fromEntries(
    Object.keys(hats).map((id) => [
      id,
      { source: "critter.svg", title: "a".repeat(60), crossMs: 90000 },
    ]),
  );
  it.each([
    normalization(
      {
        icons: { rocket: "./assets/rocket.svg" },
        hats: { beret: "./assets/beret.svg" },
        critters: { ferris: { source: "./assets/ferris.svg", title: "a crab", crossMs: 5000 } },
      },
      {
        icons: { rocket: "assets/rocket.svg" },
        hats: { beret: "assets/beret.svg" },
        critters: { ferris: { source: "assets/ferris.svg", title: "a crab", crossMs: 5000 } },
      },
    ),
    normalization({
      icons: hats,
      hats,
      critters,
    }),
    normalization(
      { backgrounds: { light: "./assets/day.png", dark: "assets/night.webp" } },
      { backgrounds: { light: "assets/day.png", dark: "assets/night.webp" } },
    ),
    normalization({ backgrounds: { dark: "night.JPEG" } }),
  ])("normalizes %j", ({ artwork, expected }) => {
    expect(normalizeManifestThemes([{ ...declaration, ...artwork }], "theme-pack")).toEqual({
      ok: true,
      themes: [{ ...declaration, ...expected }],
    });
  });

  const invalid = (artwork: Record<string, unknown>, error?: string) => ({ artwork, error });
  it.each([
    invalid({ icons: [] }),
    invalid({ icons: { claw: "rocket.svg" } }),
    invalid({ icons: entries("icon", "rocket.svg") }),
    invalid({ hats: { Beret: "beret.svg" } }),
    invalid({ hats: { fedora: "beret.svg" } }),
    invalid({ critters: { penguin: { source: "ferris.svg" } } }),
    invalid({ critters: { ferris: "ferris.svg" } }),
    invalid({ critters: { ferris: { source: "ferris.svg", extra: true } } }),
    invalid({ icons: { rocket: "../rocket.svg" } }, "SVG file inside the plugin root"),
    invalid({ hats: { beret: "beret.png" } }, "SVG file inside the plugin root"),
    invalid(
      { critters: { ferris: { source: "../ferris.svg" } } },
      "SVG file inside the plugin root",
    ),
    ...[{}, null, { dark: "night.webp", extra: "a.webp" }].map((backgrounds) =>
      invalid({ backgrounds }, "light and/or dark"),
    ),
    ...["../night.webp", "night.svg", 7].map((source) =>
      invalid({ backgrounds: { dark: source } }, "PNG, JPEG, or WebP file inside the plugin root"),
    ),
    ...[4999, 90001, 12000.5, "12000"].map((crossMs) =>
      invalid({ critters: { ferris: { source: "ferris.svg", crossMs } } }, "crossMs"),
    ),
    ...["a".repeat(61), "hello\nworld", "hello\u202e", 12].map((title) =>
      invalid({ critters: { ferris: { source: "ferris.svg", title } } }, "title"),
    ),
  ])("rejects invalid artwork declarations: %j", ({ artwork, error }) => {
    expect(normalizeManifestThemes([{ ...declaration, ...artwork }], "theme-pack")).toMatchObject({
      ok: false,
      ...(error ? { error: expect.stringContaining(error) } : {}),
    });
  });

  it.each([
    '"icons":{"rocket":"rocket.svg","rocket":"other.svg"}',
    '"hats":{"beret":"beret.svg","b\\u0065ret":"other.svg"}',
    '"critters":{"ferris":{"source":"ferris.svg"},"ferris":{"source":"other.svg"}}',
    "hats: {beret: 'beret.svg', beret: 'other.svg'}",
    '"backgrounds":{"dark":"night.webp","dark":"other.webp"}',
  ])("rejects duplicate artwork keys before JSON parsing can hide them: %s", (artwork) => {
    const rootDir = tempDirs.make("openclaw-theme-duplicate-");
    const base = JSON.stringify({
      ...declaration,
      icons: undefined,
      hats: undefined,
      critters: undefined,
    }).slice(0, -1);
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
        icons: { rocket: { svg: SVG } },
        hats: { beret: { svg: SVG } },
        critters: { ferris: { svg: SVG, title: "a crab, allegedly", crossMs: 15000 } },
      },
    });
    const changedSvg = SVG.replace("24v24", "12v12");
    fs.writeFileSync(path.join(plugin.rootDir, "beret.svg"), changedSvg);
    fs.writeFileSync(path.join(plugin.rootDir, "rocket.svg"), changedSvg);
    const after = plugin.capture();
    fs.unlinkSync(path.join(plugin.rootDir, "ferris.svg"));
    expect(before.themes?.[0]?.artwork?.icons?.rocket?.svg).toBe(SVG);
    expect(after.themes?.[0]?.artwork?.icons?.rocket?.svg).toBe(changedSvg);
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
    const file = path.join(plugin.rootDir, "rocket.svg");
    if (svg === null) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, svg);
    }
    expectRejected(plugin.capture(), "artwork rocket.svg");
  });

  it("captures sniffed raster backgrounds and omits the theme for unusable images", () => {
    const plain = createThemeDefinitionFixture();
    const plugin = fixture(
      {
        id: "night",
        name: plain.name,
        description: plain.description,
        source: "theme.json",
        backgrounds: { dark: "night.webp" },
      },
      plain,
    );
    const capture = (bytes: Buffer | string) => {
      fs.writeFileSync(path.join(plugin.rootDir, "night.webp"), bytes);
      return plugin.capture();
    };
    const captured = capture(WEBP);
    expect(captured.diagnostics).toEqual([]);
    expect(captured.themes?.[0]?.artwork).toEqual({
      backgrounds: { dark: { base64: WEBP.toString("base64") } },
    });
    for (const bytes of [
      SVG,
      "<html>not an image</html>",
      Buffer.concat([WEBP, Buffer.alloc(PLUGIN_THEME_BACKGROUND_MAX_BYTES)]),
    ]) {
      expectRejected(capture(bytes), "background night.webp");
    }
  });

  it.skipIf(process.platform === "win32")(
    "applies source-file symlink and hardlink policy to artwork",
    () => {
      const plugin = fixture();
      const outside = tempDirs.make("openclaw-theme-artwork-outside-");
      const target = path.join(outside, "art.svg");
      const artwork = path.join(plugin.rootDir, "rocket.svg");
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
