import { readFile } from "node:fs/promises";
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

const { generatedOverrides } = vi.hoisted(() => ({
  generatedOverrides: new Map<string, string>(),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const override =
        typeof args[0] === "string" ? generatedOverrides.get(path.resolve(args[0])) : undefined;
      return override === undefined ? actual.readFile(...args) : Promise.resolve(override);
    },
  };
});

function findings(source: string, file = "ui/Example.kt", flavor = "main") {
  return findUnlocalizedAndroidUiLiterals(
    source,
    `apps/android/app/src/${flavor}/java/ai/openclaw/app/${file}`,
  ).map((finding) => finding.source);
}

const sortedMatches = (source: string, pattern: RegExp, group = 0) =>
  [...source.matchAll(pattern)].map((match) => match[group]!).toSorted();

describe("Android app i18n resources", () => {
  it("counts manual resources reached only through the generated native lookup", async () => {
    const shellPath = path.resolve(
      "apps/android/app/src/main/java/ai/openclaw/app/ui/ShellScreen.kt",
    );
    const shell = await readFile(shellPath, "utf8");
    try {
      generatedOverrides.set(shellPath, shell.replaceAll("R.string.cancel", "R.string.app_name"));
      await expect(verifyAndroidAppI18n()).resolves.toBeUndefined();
    } finally {
      generatedOverrides.clear();
    }
  });

  it("keeps generated resources, runtime coverage, and every locale aligned", async () => {
    await expect(checkAndroidAppI18n({ tolerateManagedPending: true })).resolves.toBeUndefined();
    const catalog = await buildAndroidAppI18nCatalog();
    const base = catalog.resources.get(
      path.resolve("apps/android/app/build/generated/native-i18n/res/values/native_strings.xml"),
    );
    expect(base).toMatch(
      /<string name="native_[a-f0-9]+"[^>]*tools:ignore="Typos,TypographyDashes,TypographyEllipsis">/u,
    );
  });

  it("builds complete Wear and third-party resources for every native locale", async () => {
    const catalog = await buildAndroidAppI18nCatalog();
    const wearResources = [...catalog.resources].filter(
      ([filePath]) =>
        filePath.includes("/apps/android/wear/src/main/res/values-") &&
        filePath.endsWith("/strings.xml"),
    );
    const base = await readFile("apps/android/wear/src/main/res/values/strings.xml", "utf8");
    const baseKeys = sortedMatches(base, /<string name="([^"]+)"/gu, 1);
    const basePlaceholders = sortedMatches(base, /%\d+\$[a-z]/giu);

    expect(wearResources).toHaveLength(NATIVE_I18N_LOCALES.length);
    for (const [, content] of wearResources) {
      const stringTags = [...content.matchAll(/<string\b[^>]*>/gu)].map((match) => match[0]);
      const keys = stringTags
        .map((tag) => tag.match(/\bname="([^"]+)"/u)?.[1])
        .filter((key): key is string => key !== undefined)
        .toSorted();
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
    const resources = [...catalog.resources].filter(
      ([filePath]) =>
        filePath.includes("/apps/android/app/src/thirdParty/res/values-") &&
        filePath.endsWith("/accessibility_strings.xml"),
    );

    expect(thirdPartyBase).toContain('tools:ignore="MissingTranslation"');
    expect(resources).toHaveLength(NATIVE_I18N_LOCALES.length);
    for (const [, content] of resources) {
      expect(content).toContain('name="accessibility_service_label"');
      expect(content).toContain('name="accessibility_dev_activity_label"');
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
