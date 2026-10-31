import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAndroidAppI18nCatalog,
  checkAndroidAppI18n,
  decodeAndroidResourceValue,
  escapeAndroidResourceValue,
  findUnusedAndroidResourceKeys,
  findUnlocalizedAndroidUiLiterals,
  renderAndroidResourceValue as render,
  selectDeterministicTranslation,
  verifyAndroidAppI18n,
} from "../../scripts/android-app-i18n.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";

const { generatedOverrides, generatedReadSequences, hiddenSourceDirectoryEntries } = vi.hoisted(
  () => ({
    generatedOverrides: new Map<string, string | Error>(),
    generatedReadSequences: new Map<string, Array<string | Error>>(),
    hiddenSourceDirectoryEntries: new Map<string, Set<string>>(),
  }),
);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const filePath = typeof args[0] === "string" ? path.resolve(args[0]) : undefined;
      const sequence = filePath === undefined ? undefined : generatedReadSequences.get(filePath);
      const queued = sequence?.shift();
      const override =
        queued ?? (filePath === undefined ? undefined : generatedOverrides.get(filePath));
      if (override instanceof Error) {
        return Promise.reject(override);
      }
      return override === undefined ? actual.readFile(...args) : Promise.resolve(override);
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      const directory = typeof args[0] === "string" ? path.resolve(args[0]) : undefined;
      const hidden =
        directory === undefined ? undefined : hiddenSourceDirectoryEntries.get(directory);
      if (directory === undefined || hidden === undefined) {
        return actual.readdir(...args);
      }
      return actual
        .readdir(directory, { withFileTypes: true })
        .then((entries) => entries.filter((entry) => !hidden.has(entry.name)));
    },
  };
});

const APP_RESOURCE_ROOT = path.resolve("apps/android/app/src/main/res");
const GENERATED_RESOURCE_ROOT = path.resolve("apps/android/app/build/generated/native-i18n/res");
const APP_MAIN_STRINGS_PATH = "apps/android/app/src/main/res/values/strings.xml";

function setNativeArtifactFixtures(
  missingLocale?: string,
  localeTranslations: Record<string, string> = {},
  translatedLocale = "fr",
) {
  for (const locale of NATIVE_I18N_LOCALES) {
    const filePath = path.resolve(`apps/.i18n/native/${locale}.json`);
    if (locale === missingLocale) {
      generatedOverrides.set(
        filePath,
        Object.assign(new Error(`synthetic fixture omits ${locale}`), { code: "ENOENT" }),
      );
      continue;
    }
    generatedOverrides.set(
      filePath,
      JSON.stringify({
        glossaryHash: "fixture",
        locale,
        translations: locale === translatedLocale ? localeTranslations : {},
        version: 2,
      }),
    );
  }
}

async function installCompleteAndroidFixtures(
  localeTranslations: Record<string, string> = {},
  translatedLocale = "fr",
  missingAppMainLocale?: string,
) {
  generatedOverrides.clear();
  generatedReadSequences.clear();
  setNativeArtifactFixtures(undefined, localeTranslations, translatedLocale);
  if (missingAppMainLocale !== undefined) {
    generatedOverrides.set(
      path.join(APP_RESOURCE_ROOT, `values-${missingAppMainLocale}`, "strings.xml"),
      Object.assign(new Error(`synthetic fixture omits ${missingAppMainLocale} app strings`), {
        code: "ENOENT",
      }),
    );
  }
  const catalog = await buildAndroidAppI18nCatalog();
  for (const [filePath, content] of catalog.resources) {
    if (!filePath.startsWith(`${GENERATED_RESOURCE_ROOT}${path.sep}`)) {
      generatedOverrides.set(path.resolve(filePath), content);
    }
  }
  return catalog;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function snapshotAppMainLocaleStrings() {
  const directories = await readdir(APP_RESOURCE_ROOT, { withFileTypes: true });
  const snapshots = new Map<string, string>();
  for (const directory of directories) {
    if (!directory.isDirectory() || !directory.name.startsWith("values-")) {
      continue;
    }
    const filePath = path.join(APP_RESOURCE_ROOT, directory.name, "strings.xml");
    try {
      snapshots.set(filePath, await readFile(filePath, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }
  return snapshots;
}

async function localeAppMainTranslationFixtures(locale: string) {
  const inventory = JSON.parse(await readFile("apps/.i18n/native-source.json", "utf8")) as {
    sites: Array<{ id: string; path: string; source: string }>;
  };
  const sites = inventory.sites.filter((site) => site.path === APP_MAIN_STRINGS_PATH);
  const translations = Object.fromEntries(
    sites.map((site) => [
      site.id,
      `${locale}-${site.id} ${[...site.source.matchAll(/%\d+\$[a-z]/giu)]
        .map((match) => match[0])
        .join(" ")}`,
    ]),
  );
  return { sites, translations };
}

function parseStringValues(source: string) {
  return new Map(
    [...source.matchAll(/<string\s+name="([A-Za-z0-9_]+)"[^>]*>([\s\S]*?)<\/string>/gu)].map(
      (match) => [match[1] ?? "", decodeAndroidResourceValue(match[2] ?? "")] as const,
    ),
  );
}

function findings(source: string, file = "ui/Example.kt", flavor = "main") {
  return findUnlocalizedAndroidUiLiterals(
    source,
    `apps/android/app/src/${flavor}/java/ai/openclaw/app/${file}`,
  ).map((finding) => finding.source);
}

const sortedMatches = (source: string, pattern: RegExp, group = 0) =>
  [...source.matchAll(pattern)].map((match) => match[group]!).toSorted();

describe("Android app i18n resources", () => {
  it("verifies source coverage without translations and keeps strict artifact readers", async () => {
    const shellPath = path.resolve(
      "apps/android/app/src/main/java/ai/openclaw/app/ui/ShellScreen.kt",
    );
    const missingArtifact = Object.assign(new Error("synthetic fixture omits fr"), {
      code: "ENOENT",
    });
    setNativeArtifactFixtures("fr");
    const shell = await readFile(shellPath, "utf8");
    try {
      generatedOverrides.set(shellPath, shell.replaceAll("R.string.cancel", "R.string.app_name"));
      await expect(verifyAndroidAppI18n()).resolves.toBeUndefined();
      await expect(buildAndroidAppI18nCatalog()).rejects.toThrow(missingArtifact);
      await expect(checkAndroidAppI18n()).rejects.toThrow(missingArtifact);
    } finally {
      generatedOverrides.clear();
    }
  });

  it("projects a missing registered app-main locale from native translations without changing authored files", async () => {
    const locale = "fr";
    const existingMainStrings = await snapshotAppMainLocaleStrings();
    expect(existingMainStrings.size).toBe(NATIVE_I18N_LOCALES.length);
    const { sites, translations } = await localeAppMainTranslationFixtures(locale);
    expect(sites).toHaveLength(21);
    expect(Object.keys(translations)).toHaveLength(sites.length);

    const catalog = await installCompleteAndroidFixtures(translations, locale, locale);
    const generatedPath = path.join(GENERATED_RESOURCE_ROOT, "values-fr", "strings.xml");
    const generated = catalog.resources.get(generatedPath);
    expect(generated).toBeDefined();
    const generatedAppMainPaths = [...catalog.resources.keys()]
      .filter(
        (filePath) =>
          filePath.startsWith(`${GENERATED_RESOURCE_ROOT}${path.sep}values-`) &&
          filePath.endsWith(`${path.sep}strings.xml`),
      )
      .toSorted();
    expect(generatedAppMainPaths).toEqual([generatedPath]);
    const frDirectory = path.join(APP_RESOURCE_ROOT, "values-fr");
    hiddenSourceDirectoryEntries.set(frDirectory, new Set(["strings.xml"]));

    const baseSource = await readFile(
      path.join(APP_RESOURCE_ROOT, "values", "strings.xml"),
      "utf8",
    );
    const baseEntries = [
      ...baseSource.matchAll(/<string\s+name="([A-Za-z0-9_]+)"([^>]*)>([\s\S]*?)<\/string>/gu),
    ];
    const idBySource = new Map(sites.map((site) => [site.source, site.id]));
    const generatedValues = parseStringValues(generated ?? "");
    expect(baseEntries).toHaveLength(21);
    expect([...generatedValues.keys()].toSorted()).toEqual(
      baseEntries.map((entry) => entry[1] ?? "").toSorted(),
    );
    for (const entry of baseEntries) {
      const key = entry[1] ?? "";
      const attrs = entry[2] ?? "";
      const source = decodeAndroidResourceValue(entry[3] ?? "");
      const id = idBySource.get(source);
      expect(id).toBeDefined();
      const expected = /\btranslatable\s*=\s*"false"/u.test(attrs)
        ? source
        : translations[id ?? ""];
      expect(expected).toBeDefined();
      const value = generatedValues.get(key);
      expect(value).toBe(expected);
      const placeholders = (text: string) =>
        [...text.matchAll(/%\d+\$[a-z]/giu)].map((match) => match[0]);
      expect(placeholders(value ?? "").toSorted()).toEqual(placeholders(source).toSorted());
    }

    try {
      await expect(checkAndroidAppI18n()).resolves.toBeUndefined();
      generatedOverrides.delete(path.join(APP_RESOURCE_ROOT, "values-fr", "strings.xml"));
      hiddenSourceDirectoryEntries.delete(frDirectory);
      expect(await snapshotAppMainLocaleStrings()).toEqual(existingMainStrings);
    } finally {
      generatedOverrides.clear();
      generatedReadSequences.clear();
      hiddenSourceDirectoryEntries.clear();
    }
  });

  it("rejects a missing generated projection if the authored file disappears after catalog planning", async () => {
    generatedOverrides.clear();
    generatedReadSequences.clear();
    setNativeArtifactFixtures();
    const frMainPath = path.join(APP_RESOURCE_ROOT, "values-fr", "strings.xml");
    const authored = await readFile(frMainPath, "utf8");
    generatedOverrides.set(frMainPath, authored);
    const planned = await buildAndroidAppI18nCatalog();
    const generatedPath = path.join(GENERATED_RESOURCE_ROOT, "values-fr", "strings.xml");
    expect(planned.resources.has(generatedPath)).toBe(false);
    for (const [filePath, content] of planned.resources) {
      if (!filePath.startsWith(`${GENERATED_RESOURCE_ROOT}${path.sep}`)) {
        generatedOverrides.set(path.resolve(filePath), content);
      }
    }
    generatedOverrides.delete(frMainPath);
    generatedReadSequences.set(frMainPath, [
      authored,
      Object.assign(new Error("synthetic app-main resource disappeared"), { code: "ENOENT" }),
    ]);
    hiddenSourceDirectoryEntries.set(path.dirname(frMainPath), new Set(["strings.xml"]));
    try {
      await expect(checkAndroidAppI18n()).rejects.toThrow(/app-main strings.*values-fr/iu);
    } finally {
      generatedOverrides.clear();
      generatedReadSequences.clear();
      hiddenSourceDirectoryEntries.clear();
    }
  });

  it("preserves non-missing app-main read failures", async () => {
    generatedOverrides.clear();
    generatedReadSequences.clear();
    setNativeArtifactFixtures();
    const frMainPath = path.join(APP_RESOURCE_ROOT, "values-fr", "strings.xml");
    const authored = await readFile(frMainPath, "utf8");
    generatedOverrides.set(frMainPath, authored);
    const catalog = await buildAndroidAppI18nCatalog();
    for (const [filePath, content] of catalog.resources) {
      if (!filePath.startsWith(`${GENERATED_RESOURCE_ROOT}${path.sep}`)) {
        generatedOverrides.set(path.resolve(filePath), content);
      }
    }
    generatedReadSequences.set(frMainPath, [
      authored,
      Object.assign(new Error("synthetic app-main read failure"), { code: "EACCES" }),
    ]);
    try {
      await expect(checkAndroidAppI18n()).rejects.toMatchObject({
        code: "EACCES",
        message: "synthetic app-main read failure",
      });
    } finally {
      generatedOverrides.clear();
      generatedReadSequences.clear();
    }
  });

  it("does not replace malformed present app-main XML with a generated projection", async () => {
    generatedOverrides.clear();
    generatedReadSequences.clear();
    setNativeArtifactFixtures();
    const frMainPath = path.join(APP_RESOURCE_ROOT, "values-fr", "strings.xml");
    const authored = await readFile(frMainPath, "utf8");
    const malformed = authored.replace("</string>", "");
    generatedOverrides.set(frMainPath, malformed);
    const catalog = await buildAndroidAppI18nCatalog();
    const generatedPath = path.join(GENERATED_RESOURCE_ROOT, "values-fr", "strings.xml");
    expect(catalog.resources.has(generatedPath)).toBe(false);
    for (const [filePath, content] of catalog.resources) {
      if (!filePath.startsWith(`${GENERATED_RESOURCE_ROOT}${path.sep}`)) {
        generatedOverrides.set(path.resolve(filePath), content);
      }
    }
    try {
      await expect(checkAndroidAppI18n()).rejects.toThrow(/App fr missing/iu);
      expect(generatedOverrides.get(frMainPath)).toBe(malformed);
    } finally {
      generatedOverrides.clear();
      generatedReadSequences.clear();
    }
  });

  it("rejects changed Wear resources and emits lint-safe native strings", async () => {
    const catalog = await installCompleteAndroidFixtures();
    const wearRelativePath = "apps/android/wear/src/main/res/values-sv/strings.xml";
    const wearPath = path.resolve(wearRelativePath);
    const wear = catalog.resources.get(wearPath);
    const driftedWear = wear?.replace(
      /(<string name="[^"]+"[^>]*>)([\s\S]*?)(<\/string>)/u,
      "$1$2 fixture drift$3",
    );
    expect(driftedWear).toBeDefined();
    generatedOverrides.set(wearPath, driftedWear ?? "");
    try {
      await expect(checkAndroidAppI18n()).rejects.toThrow(wearRelativePath);
      const base = catalog.resources.get(
        path.resolve("apps/android/app/build/generated/native-i18n/res/values/native_strings.xml"),
      );
      expect(base).toMatch(
        /<string name="native_[a-f0-9]+"[^>]*tools:ignore="Typos,TypographyDashes,TypographyEllipsis">/u,
      );
    } finally {
      generatedOverrides.clear();
    }
  });

  it("builds complete Wear and third-party resources for every native locale", async () => {
    generatedOverrides.clear();
    setNativeArtifactFixtures();
    try {
      const catalog = await buildAndroidAppI18nCatalog();
      const resourcesFor = (directory: string, filename: string) =>
        [...catalog.resources].filter(
          ([file]) => file.includes(directory) && file.endsWith(filename),
        );
      const wearResources = resourcesFor("/apps/android/wear/src/main/res/values-", "/strings.xml");
      const base = await readFile("apps/android/wear/src/main/res/values/strings.xml", "utf8");
      const baseKeys = sortedMatches(base, /<string name="([^"]+)"/gu, 1);
      const basePlaceholders = sortedMatches(base, /%\d+\$[a-z]/giu);

      expect(wearResources).toHaveLength(NATIVE_I18N_LOCALES.length);
      for (const [, content] of wearResources) {
        const stringTags = [...content.matchAll(/<string\b[^>]*>/gu)].map((match) => match[0]);
        const keys = sortedMatches(stringTags.join("\n"), /\bname="([^"]+)"/gu, 1);
        expect(keys).toEqual(baseKeys);
        expect(sortedMatches(content, /%\d+\$[a-z]/giu)).toEqual(basePlaceholders);
        expect(content).not.toMatch(/(?:&apos;|(?<!\\)')/u);
        expect(content).toContain('<resources xmlns:tools="http://schemas.android.com/tools">');
        for (const tag of stringTags) {
          if (!tag.includes('translatable="false"')) {
            expect(tag.match(/\btools:ignore=/gu)).toHaveLength(1);
            expect(tag).toMatch(/\btools:ignore="[^"]*\bTypos\b[^"]*"/u);
            expect(tag).toMatch(/\btools:ignore="[^"]*\bTypographyDashes\b[^"]*"/u);
            expect(tag).toMatch(/\btools:ignore="[^"]*\bTypographyEllipsis\b[^"]*"/u);
          }
        }
        expect(content).toContain(
          'name="open_thread" tools:ignore="MissingTranslation,Typos,TypographyDashes,TypographyEllipsis"',
        );
        expect(content).toContain(
          'name="show_new_messages" tools:ignore="MissingTranslation,Typos,TypographyDashes,TypographyEllipsis"',
        );
      }

      const thirdPartyBase = await readFile(
        "apps/android/app/src/thirdParty/res/values/accessibility_strings.xml",
        "utf8",
      );
      const resources = resourcesFor(
        "/apps/android/app/src/thirdParty/res/values-",
        "/accessibility_strings.xml",
      );

      expect(thirdPartyBase).toContain('tools:ignore="MissingTranslation"');
      expect(resources).toHaveLength(NATIVE_I18N_LOCALES.length);
      for (const [, content] of resources) {
        expect(content).toContain('name="accessibility_service_label"');
        expect(content).toContain('name="accessibility_dev_activity_label"');
      }
      expect(
        catalog.resources.has(
          path.resolve(
            "apps/android/app/build/generated/native-i18n/res/values-pt-rBR/native_strings.xml",
          ),
        ),
      ).toBe(true);
    } finally {
      generatedOverrides.clear();
    }
  });

  it("preserves the existing Swedish app name", async () => {
    const strings = await readFile("apps/android/app/src/main/res/values-sv/strings.xml", "utf8");
    expect(strings).toContain('<string name="app_name">OpenClaw-nod</string>');
  });

  it.each<[string, string[], string]>([
    ["frequency", ["Beta", "Alpha", "Beta"], "Beta"],
    ["stable order", ["Beta", "Alpha"], "Alpha"],
    ["translated candidate", ["Source", "Translated", "Source"], "Translated"],
    ["source fallback", ["Source", "Source"], "Source"],
  ])("selects translations by %s", (_name, values, expected) => {
    expect(selectDeterministicTranslation("Source", values)).toBe(expected);
  });

  it.each([
    {
      name: "requires exact resource identifiers",
      keys: ["native_status", "native_status_detail", "native_unused"],
      source: "R.string.native_status_detail",
      unused: ["native_status", "native_unused"],
    },
    {
      name: "ignores references in comments",
      keys: ["kotlin_comment", "block_comment", "xml_comment", "live"],
      source: `
              // R.string.kotlin_comment
              /* R.string.block_comment */
              val endpoint = "https://example.test"
              val marker = "/* not a comment */"
              R.string.live
            `,
      xml: "<!-- @string/xml_comment -->",
      unused: ["kotlin_comment", "block_comment", "xml_comment"],
    },
    {
      name: "ignores references inside Kotlin strings",
      keys: ["regular_string", "raw_string", "live"],
      source: `
              val regular = "R.string.regular_string"
              val raw = """R.string.raw_string"""
              R.string.live
            `,
      unused: ["regular_string", "raw_string"],
    },
  ])("$name", ({ keys, source, xml, unused }) => {
    const files = [{ path: "Example.kt", source }];
    if (xml) {
      files.push({ path: "AndroidManifest.xml", source: xml });
    }
    expect(findUnusedAndroidResourceKeys(keys, files)).toEqual(unused);
  });

  it("decodes quoted Android resources for canonical translation inputs", () => {
    expect(decodeAndroidResourceValue('"Sitzungen"')).toBe("Sitzungen");
    expect(decodeAndroidResourceValue('"Sag \\"Hallo\\""')).toBe('Sag "Hallo"');
  });

  it("formats nested Kotlin interpolations as single Android arguments", () => {
    expect(
      render(
        "${device.tokens.count { !it.revoked }}/${device.tokens.size} active tokens",
        "${device.tokens.size} Token, ${device.tokens.count { !it.revoked }} aktiv",
      ),
    ).toBe("%2$s Token, %1$s aktiv");
  });

  it("preserves Android resource placeholders outside Kotlin interpolation", () => {
    expect(escapeAndroidResourceValue("Previous %1$s")).toBe("Previous %1$s");
  });

  it("balances braces inside nested interpolation strings", () => {
    expect(
      render('${if (connected) "{" else "}"} $count', '$count · ${if (connected) "{" else "}"}'),
    ).toBe("%2$s · %1$s");
  });

  it("rejects repeated translation placeholders that do not match the source", () => {
    expect(() => render("$item then $item", "$item, $item und noch einmal $item")).toThrow(
      "Android translation changed interpolation placeholders",
    );
  });

  it("finds direct, typed, conditional, interpolated, Elvis, and accessibility literals", () => {
    const source = `
      data class ConnectionState(val connected: Boolean, val statusText: String)
      data class SettingsToggleRow(val title: String, val subtitle: String)
      Text("Text")
      Text(text = nativeStringResource("Connected"))
      ClawPrimaryButton(text = "Go", onClick = {})
      ClawStatusPill(text = "Busy")
      SettingsMetric("Host", gatewayName)
      ConnectionState(connected = false, statusText = "$host")
      ConnectionState(connected = true, statusText = nativeString("Connected"))
      SettingsToggleRow(
        "Title",
        "Hint",
      )
      SettingsToggleRow(nativeString("Localized capability"), nativeString("Localized detail"))
      Text(text = fileName ?: "File")
      Modifier.clickable(onClickLabel = "Open", onClick = {})
      Text(nativeString("First sentence. ") + "More")
      val dynamic = Text(text = gateway.name)
      fun statusText(state: State): String =
        when (state) {
          State.Ready -> "Ready"
          State.Waiting -> nativeString("Waiting")
        }
    `;
    expect(findings(source)).toEqual(
      "Text Go Busy Host $host Title Hint File Open More Ready".split(" "),
    );
  });

  it("maps typed model fields across generic types and named argument omissions", () => {
    const source = `
      data class GenericState<T : Map<String, String>>(
        val metadata: Map<String, String>,
        val statusText: String,
      )
      data class OptionalState(val statusText: String = "", val code: String)
      GenericState<Map<String, String>>(emptyMap(), "Generic ready")
      OptionalState(code = "Internal code")
    `;
    expect(findings(source)).toEqual(["Generic ready"]);
  });

  it("scans helpers with generic and lambda parameters", () => {
    const source = `
      fun <T> statusText(value: T, transform: (T) -> String): String =
        if (transform(value).isBlank()) "No status" else nativeString("Ready")
    `;
    expect(findings(source)).toEqual(["No status"]);
  });

  it("finds raw strings in direct UI and presentation helpers", () => {
    const source = `
      Text("""Direct raw copy""")
      fun diagnosticsReport(): String =
        """
          Raw helper copy
        """.trimIndent()
    `;
    expect(findings(source)).toEqual(
      expect.arrayContaining(["Direct raw copy", expect.stringContaining("Raw helper copy")]),
    );
  });

  it("decodes Kotlin Unicode escapes without collapsing escaped backslashes", () => {
    const source = String.raw`
      Text("Progress \u00b7 ready")
      Text("Literal \\u00b7 marker")
    `;
    expect(findings(source)).toEqual(["Progress · ready", String.raw`Literal \u00b7 marker`]);
  });

  it("inventories command, attention, and overview model display literals", () => {
    const source = `
      data class CommandItem(val key: String, val title: String, val subtitle: String)
      data class HomeAttentionRow(val title: String, val subtitle: String, val route: String)
      data class OverviewMetricCardSpec(val title: String, val value: String, val subtitle: String)
      CommandItem("chat", "Chat", "Start")
      CommandItem(key = "voice", title = nativeString("Voice"), subtitle = nativeString("Talk"))
      HomeAttentionRow(title = "Gateway",
        subtitle = "Connect", route = "gateway")
      OverviewMetricCardSpec(title = nativeString("Gateway"),
        value = if (connected) "Online" else nativeString("Offline"),
        subtitle = "Fine")
    `;
    expect(findings(source)).toEqual(["Chat", "Start", "Gateway", "Connect", "Online", "Fine"]);
  });

  it("scans flavor-specific activity surfaces", () => {
    expect(
      findings(
        'Text("Developer surface")',
        "accessibility/AccessibilityDevActivity.kt",
        "thirdParty",
      ),
    ).toEqual(["Developer surface"]);
  });

  it("keeps scanner boundaries for an unclosed quoted parameter", () => {
    expect(
      findings('fun statusText(token: String = "unterminated): String = "Ready"', "ui/Scanner.kt"),
    ).toEqual([]);
  });
});
