import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyControlUiPluginCatalogs } from "../../scripts/control-ui-i18n-verify.ts";
import { loadControlUiPluginCatalogs } from "../../scripts/lib/control-ui-plugin-i18n-catalog.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function createPluginFixture(
  options: {
    source?: unknown;
    translations?: unknown;
    reference?: string;
    browserDir?: string;
  } = {},
) {
  const root = tempDirs.make("openclaw-plugin-i18n-");
  const pluginRoot = path.join(root, "extensions", "example");
  const browserDir = options.browserDir ?? "browser";
  const browserRoot = path.join(pluginRoot, browserDir);
  const localesRoot = path.join(browserRoot, "i18n", "locales");
  fs.mkdirSync(localesRoot, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({ id: "example" }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({
      name: "@openclaw/example",
      type: "module",
      openclaw: {
        controlUi: `./${browserDir}/index.ts`,
        build: { bundledDist: false },
        release: { publishToNpm: true },
      },
    }),
  );
  fs.writeFileSync(path.join(browserRoot, "index.ts"), options.reference ?? 't("example.title");');
  fs.writeFileSync(
    path.join(localesRoot, "en.ts"),
    `export default ${JSON.stringify(
      options.source ?? { example: { title: "Open {count}", missing: "English fallback" } },
    )};\n`,
  );
  const translatedPath = path.join(localesRoot, "translated.json");
  fs.writeFileSync(
    translatedPath,
    JSON.stringify(
      options.translations ?? {
        fr: { example: { historical: "Conserver", title: "Ouvrir {count}" } },
      },
      null,
      2,
    ),
  );
  return { root, pluginRoot, browserRoot, localesRoot, translatedPath };
}

describe("plugin Control UI locale discovery", () => {
  it("follows browser entries outside the conventional browser directory", async () => {
    const fixture = createPluginFixture({ browserDir: "src" });
    expect((await loadControlUiPluginCatalogs(fixture.root))[0]?.browserRoot).toBe(
      "extensions/example/src",
    );
    expect((await verifyControlUiPluginCatalogs(fixture.root))[0]?.literalReferences).toBe(1);
  });
  it("discovers external source packages independently of the selected build subset", async () => {
    const fixture = createPluginFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS", "some-other-plugin");
    vi.stubEnv("OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS", "some-other-plugin");
    const catalogs = await loadControlUiPluginCatalogs(fixture.root);
    expect(catalogs).toEqual([
      {
        id: "example",
        browserRoot: "extensions/example/browser",
        source: { example: { title: "Open {count}", missing: "English fallback" } },
        translations: { fr: { example: { historical: "Conserver", title: "Ouvrir {count}" } } },
      },
    ]);
  });

  it("allows English-only plugins and skips entries without locale sources", async () => {
    const fixture = createPluginFixture();
    fs.unlinkSync(fixture.translatedPath);
    expect((await loadControlUiPluginCatalogs(fixture.root))[0]?.translations).toEqual({});
    fs.unlinkSync(path.join(fixture.localesRoot, "en.ts"));
    expect(await loadControlUiPluginCatalogs(fixture.root)).toEqual([]);
  });

  it.each(["entry", "source", "translations"])(
    "rejects %s paths outside the plugin",
    async (surface) => {
      const fixture = createPluginFixture();
      const outside = path.join(fixture.root, "outside.ts");
      fs.writeFileSync(outside, "export default {};\n");
      if (surface === "entry") {
        fs.writeFileSync(
          path.join(fixture.pluginRoot, "package.json"),
          JSON.stringify({
            openclaw: { controlUi: "../../outside.ts" },
          }),
        );
      } else {
        const target =
          surface === "source" ? path.join(fixture.localesRoot, "en.ts") : fixture.translatedPath;
        fs.unlinkSync(target);
        fs.symlinkSync(outside, target);
      }
      await expect(loadControlUiPluginCatalogs(fixture.root)).rejects.toThrow(
        "Control UI locale sources must stay inside the plugin package.",
      );
    },
  );
});

describe("plugin Control UI locale verification", () => {
  it("checks current references and placeholders without rewriting authored translations", async () => {
    const fixture = createPluginFixture();
    fs.writeFileSync(path.join(fixture.browserRoot, "example.test.ts"), 't("fixture-only");');
    const before = fs.readFileSync(fixture.translatedPath);
    expect(await verifyControlUiPluginCatalogs(fixture.root)).toEqual([
      {
        id: "example",
        keys: 2,
        locales: 1,
        unusedTranslations: 1,
        literalReferences: 1,
        templatePrefixReferences: 0,
      },
    ]);
    expect(fs.readFileSync(fixture.translatedPath)).toEqual(before);
  });

  it.each([
    { translations: [], error: "translated.json must contain locale catalogs" },
    {
      translations: { fr: { example: { title: {} } } },
      error: "must be a string at an English leaf",
    },
    {
      translations: { fr: { example: { title: { historical: "Retained" } } } },
      error: "must be a string at an English leaf",
    },
    { translations: { unknown: {} }, error: "unsupported locale unknown" },
    { translations: { fr: { example: { title: 42 } } }, error: "must be a string or object" },
    { translations: { fr: { example: { title: "Ouvrir" } } }, error: "expected {count} got {}" },
  ])("rejects invalid authored catalogs: $error", async ({ translations, error }) => {
    const fixture = createPluginFixture({ translations });
    await expect(verifyControlUiPluginCatalogs(fixture.root)).rejects.toThrow(error);
  });

  it("rejects references without an English source key", async () => {
    const fixture = createPluginFixture({ reference: 't("example.unknown");' });
    await expect(verifyControlUiPluginCatalogs(fixture.root)).rejects.toThrow(
      'missing English catalog key "example.unknown"',
    );
  });
});
