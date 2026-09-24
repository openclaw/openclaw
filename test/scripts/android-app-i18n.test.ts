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
  renderAndroidResourceValue,
  selectDeterministicTranslation,
  selectGeneratedTranslation,
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

describe("Android app i18n resources", () => {
  it("keeps generated resources, runtime coverage, and every locale aligned", async () => {
    // Managed native_* rows are reconciled by the post-merge locale refresh
    // workflow (#111557); source PRs are validated with those rows pending.
    await expect(checkAndroidAppI18n({ tolerateManagedPending: true })).resolves.toBeUndefined();
    const base = await readFile("apps/android/app/src/main/res/values/strings.xml", "utf8");
    const wearBase = await readFile("apps/android/wear/src/main/res/values/strings.xml", "utf8");
    expect(base).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(base).toMatch(
      /<string name="native_[a-f0-9]+"[^>]*tools:ignore="Typos,TypographyDashes,TypographyEllipsis">/u,
    );
    expect(wearBase).toContain('<string name="current_session">Current session</string>');
  });

  it("warns only when obsolete generated rows are the entire localization drift", async () => {
    const kotlinPath = path.resolve(
      "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt",
    );
    const currentKotlin = await readFile(kotlinPath, "utf8");
    const obsoleteKotlin = '    "Talk stopped" to R.string.native_c38a575f77e9b336,\n';
    const obsoleteString =
      '    <string name="native_c38a575f77e9b336" formatted="false" tools:ignore="Typos,TypographyDashes,TypographyEllipsis">"Talk stopped"</string>\n';
    const catalog = await buildAndroidAppI18nCatalog();
    const warnings: string[] = [];
    const options = { reportObsolete: (message: string) => warnings.push(message) };
    const stringPaths = [...catalog.resources.keys()].filter(
      (filePath) => filePath.includes("/app/src/main/res/") && filePath.endsWith("/strings.xml"),
    );
    const basePath = path.resolve("apps/android/app/src/main/res/values/strings.xml");
    try {
      generatedOverrides.set(kotlinPath, currentKotlin.replace("  )\n", `${obsoleteKotlin}  )\n`));
      for (const filePath of stringPaths) {
        const current = await readFile(filePath, "utf8");
        generatedOverrides.set(
          filePath,
          current.replace("</resources>\n", `${obsoleteString}</resources>\n`),
        );
      }
      await expect(checkAndroidAppI18n()).rejects.toThrow("Android generated localization drift");
      await expect(checkAndroidAppI18n(options)).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Android obsolete generated localization rows:");

      for (const fixture of [
        {
          filePath: "apps/android/app/src/play/java/ai/openclaw/app/SensitiveFeatureConfig.kt",
          reference: (source: string) =>
            `${source}\nprivate val retainedLabel = R.string.native_c38a575f77e9b336\n`,
        },
        {
          filePath: "apps/android/app/src/thirdParty/AndroidManifest.xml",
          reference: (source: string) =>
            source.replace(
              "<application>",
              '<application><meta-data android:name="openclaw.test.retainedLabel" android:resource="@string/native_c38a575f77e9b336" />',
            ),
        },
      ]) {
        const filePath = path.resolve(fixture.filePath);
        generatedOverrides.set(filePath, fixture.reference(await readFile(filePath, "utf8")));
        await expect(checkAndroidAppI18n(options)).rejects.toThrow(
          "Android generated localization drift",
        );
        generatedOverrides.delete(filePath);
      }

      const obsoleteBase = await readFile(basePath, "utf8");
      const currentBase = obsoleteBase.replace(obsoleteString, "");
      for (const invalidBase of [
        obsoleteBase.replace(obsoleteString, `${obsoleteString}${obsoleteString}`),
        obsoleteBase.replace('>"Talk stopped"</string>', '>"Talk & stopped"</string>'),
        obsoleteBase.replace(/ {4}<string name="native_[a-f0-9]+"[^\n]*\n/u, ""),
        `${obsoleteBase}malformed\n`,
        `${obsoleteString}${currentBase}`,
        `${currentBase}${obsoleteString}`,
      ]) {
        generatedOverrides.set(basePath, invalidBase);
        await expect(checkAndroidAppI18n(options)).rejects.toThrow(
          "Android generated localization drift",
        );
      }
      generatedOverrides.set(basePath, obsoleteBase);
      for (const invalidKotlin of [
        `${currentKotlin}malformed\n${obsoleteKotlin}`,
        `${obsoleteKotlin}${currentKotlin}`,
        `${currentKotlin}${obsoleteKotlin}`,
      ]) {
        generatedOverrides.set(kotlinPath, invalidKotlin);
        await expect(checkAndroidAppI18n(options)).rejects.toThrow(
          "Android generated localization drift",
        );
      }
    } finally {
      generatedOverrides.clear();
    }
  });

  it("routes compact token suffixes through generated resources", async () => {
    const inventory = JSON.parse(await readFile("apps/.i18n/native-source.json", "utf8")) as {
      entries: Array<{ sites: Array<{ kind: string; path: string }>; source: string }>;
    };
    const sources = new Set(["${decimal(count / 1_000_000.0)}M", "${thousands}k"]);
    const entries = inventory.entries
      .flatMap((entry) => entry.sites.map((site) => ({ ...site, source: entry.source })))
      .filter(
        (entry) => entry.path.endsWith("/ui/chat/ChatTurnRecap.kt") && sources.has(entry.source),
      )
      .map(({ kind, source }) => ({ kind, source }))
      .toSorted((left, right) => left.source.localeCompare(right.source));

    expect(entries).toEqual([
      { kind: "ui-call", source: "${decimal(count / 1_000_000.0)}M" },
      { kind: "ui-call", source: "${thousands}k" },
    ]);
  });

  it("builds complete Wear and third-party resources for every native locale", async () => {
    const catalog = await buildAndroidAppI18nCatalog();
    const wearResources = [...catalog.resources].filter(
      ([filePath]) =>
        filePath.includes("/apps/android/wear/src/main/res/values-") &&
        filePath.endsWith("/strings.xml"),
    );
    const base = await readFile("apps/android/wear/src/main/res/values/strings.xml", "utf8");
    const baseKeys = [...base.matchAll(/<string name="([^"]+)"/gu)]
      .map((match) => match[1] as string)
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const basePlaceholders = [...base.matchAll(/%\d+\$[a-z]/giu)]
      .map((match) => match[0])
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));

    expect(wearResources).toHaveLength(NATIVE_I18N_LOCALES.length);
    for (const [, content] of wearResources) {
      const stringTags = [...content.matchAll(/<string\b[^>]*>/gu)].map((match) => match[0]);
      const keys = stringTags
        .map((tag) => tag.match(/\bname="([^"]+)"/u)?.[1])
        .filter((key): key is string => key !== undefined)
        .toSorted();
      const placeholders = [...content.matchAll(/%\d+\$[a-z]/giu)]
        .map((match) => match[0])
        .toSorted();
      expect(keys).toEqual(baseKeys);
      expect(placeholders).toEqual(basePlaceholders);
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

  it("counts Kotlin and XML resource references", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["kotlin_only", "manifest_only", "values_only", "unused"],
        [
          { path: "Example.kt", source: "R.string.kotlin_only" },
          {
            path: "AndroidManifest.xml",
            source:
              'android:label="@string/manifest_only" <string name="alias">@string/values_only</string>',
          },
        ],
      ),
    ).toEqual(["unused"]);
  });

  it("requires exact Android resource reference identifiers", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["native_status", "native_status_detail", "native_unused"],
        [{ path: "Example.kt", source: "R.string.native_status_detail" }],
      ),
    ).toEqual(["native_status", "native_unused"]);
  });

  it("ignores Android resource references that only appear in comments", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["kotlin_comment", "block_comment", "xml_comment", "live"],
        [
          {
            path: "Example.kt",
            source: `
              // R.string.kotlin_comment
              /* R.string.block_comment */
              val endpoint = "https://example.test"
              val marker = "/* not a comment */"
              R.string.live
            `,
          },
          {
            path: "AndroidManifest.xml",
            source: "<!-- @string/xml_comment -->",
          },
        ],
      ),
    ).toEqual(["kotlin_comment", "block_comment", "xml_comment"]);
  });

  it("ignores Android resource references inside Kotlin strings", () => {
    expect(
      findUnusedAndroidResourceKeys(
        ["regular_string", "raw_string", "live"],
        [
          {
            path: "Example.kt",
            source: `
              val regular = "R.string.regular_string"
              val raw = """R.string.raw_string"""
              R.string.live
            `,
          },
        ],
      ),
    ).toEqual(["regular_string", "raw_string"]);
  });

  it("selects duplicate-source translations by frequency then stable text order", () => {
    expect(selectDeterministicTranslation("Source", ["Beta", "Alpha", "Beta"])).toBe("Beta");
    expect(selectDeterministicTranslation("Source", ["Beta", "Alpha"])).toBe("Alpha");
  });

  it("prefers a translated candidate over repeated source fallbacks", () => {
    expect(selectDeterministicTranslation("Source", ["Source", "Translated", "Source"])).toBe(
      "Translated",
    );
    expect(selectDeterministicTranslation("Source", ["Source", "Source"])).toBe("Source");
  });

  it("preserves a localized resource when translation memory retires its UI source", () => {
    expect(decodeAndroidResourceValue('"Sitzungen"')).toBe("Sitzungen");
    expect(decodeAndroidResourceValue('"Sag \\"Hallo\\""')).toBe('Sag "Hallo"');
    const existing = { source: "Sessions", translation: "Sitzungen" };
    expect(selectGeneratedTranslation("Sessions", [], existing)).toBe("Sitzungen");
    expect(selectGeneratedTranslation("Sessions", ["Sesiones"], existing)).toBe("Sesiones");
  });

  it("does not reuse a localized resource after its English source changes", () => {
    const existing = { source: "Sessions", translation: "Sitzungen" };
    expect(selectGeneratedTranslation("Threads", [], existing)).toBe("");
  });

  it("preserves source argument indexes when a translation reorders interpolations", () => {
    expect(
      renderAndroidResourceValue(
        "$readyProviderCount of $providerCount providers ready",
        "$providerCount Anbieter, davon $readyProviderCount bereit",
      ),
    ).toBe("%2$s Anbieter, davon %1$s bereit");
  });

  it("formats nested Kotlin interpolations as single Android arguments", () => {
    expect(
      renderAndroidResourceValue(
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
      renderAndroidResourceValue(
        '${if (connected) "{" else "}"} $count',
        '$count · ${if (connected) "{" else "}"}',
      ),
    ).toBe("%2$s · %1$s");
  });

  it("rejects repeated translation placeholders that do not match the source", () => {
    expect(() =>
      renderAndroidResourceValue("$item then $item", "$item, $item und noch einmal $item"),
    ).toThrow("Android translation changed interpolation placeholders");
  });

  it("finds direct, typed, conditional, interpolated, Elvis, and accessibility literals", () => {
    const source = `
      data class ConnectionState(
        val connected: Boolean,
        val statusText: String,
      )
      data class SettingsToggleRow(
        val title: String,
        val subtitle: String,
      )

      Text("Settings")
      Text(text = nativeStringResource("Connected"))
      ClawPrimaryButton(text = "Continue", onClick = {})
      ClawStatusPill(text = "Working")
      SettingsMetric("Gateway", gatewayName)
      ConnectionState(connected = false, statusText = "Connecting to $host")
      ConnectionState(connected = true, statusText = nativeString("Connected"))
      SettingsToggleRow("Phone capability", "Share device data")
      SettingsToggleRow(nativeString("Localized capability"), nativeString("Localized detail"))
      Text(text = fileName ?: "Attachment")
      Modifier.clickable(onClickLabel = "Open detail", onClick = {})
      Text(nativeString("First sentence. ") + "Second sentence.")
      val dynamic = Text(text = gateway.name)

      fun statusText(state: State): String =
        when (state) {
          State.Ready -> "Ready"
          State.Waiting -> nativeString("Waiting")
        }
    `;
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
      ),
    ).toEqual([
      expect.objectContaining({ source: "Settings" }),
      expect.objectContaining({ source: "Continue" }),
      expect.objectContaining({ source: "Working" }),
      expect.objectContaining({ source: "Gateway" }),
      expect.objectContaining({ source: "Connecting to $host" }),
      expect.objectContaining({ source: "Phone capability" }),
      expect.objectContaining({ source: "Share device data" }),
      expect.objectContaining({ source: "Attachment" }),
      expect.objectContaining({ source: "Open detail" }),
      expect.objectContaining({ source: "Second sentence." }),
      expect.objectContaining({ source: "Ready" }),
    ]);
  });

  it("maps typed model fields across generic types and named argument omissions", () => {
    const source = `
      data class GenericState<T : Map<String, String>>(
        val metadata: Map<String, String>,
        val statusText: String,
      )
      data class OptionalState(
        val statusText: String = "",
        val code: String,
      )

      GenericState<Map<String, String>>(emptyMap(), "Generic ready")
      OptionalState(code = "Internal code")
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toContain("Generic ready");
    expect(findings).not.toContain("Internal code");
  });

  it("scans helpers with generic and lambda parameters", () => {
    const source = `
      fun <T> statusText(value: T, transform: (T) -> String): String =
        if (transform(value).isBlank()) "No status" else nativeString("Ready")
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toContain("No status");
    expect(findings).not.toContain("Ready");
  });

  it("finds raw strings in direct UI and presentation helpers", () => {
    const source = `
      Text("""Direct raw copy""")

      fun diagnosticsReport(): String =
        """
          Raw helper copy
        """.trimIndent()
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(
      expect.arrayContaining(["Direct raw copy", expect.stringContaining("Raw helper copy")]),
    );
  });

  it("decodes Kotlin Unicode escapes without collapsing escaped backslashes", () => {
    const source = String.raw`
      Text("Progress \u00b7 ready")
      Text("Literal \\u00b7 marker")
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(["Progress · ready", String.raw`Literal \u00b7 marker`]);
  });

  it("inventories command, attention, and overview model display literals", () => {
    const source = `
      data class CommandItem(
        val key: String,
        val title: String,
        val subtitle: String,
      )
      data class HomeAttentionRow(
        val title: String,
        val subtitle: String,
        val route: String,
      )
      data class OverviewMetricCardSpec(
        val title: String,
        val value: String,
        val subtitle: String,
      )

      CommandItem("chat", "Open Chat", "Start a conversation")
      CommandItem(
        key = "voice",
        title = nativeString("Start Voice"),
        subtitle = nativeString("Talk with OpenClaw"),
      )
      HomeAttentionRow(
        title = "Gateway",
        subtitle = "Connect before chat, voice, and live status.",
        route = "gateway",
      )
      OverviewMetricCardSpec(
        title = nativeString("Gateway"),
        value = if (connected) "Online" else nativeString("Offline"),
        subtitle = "All systems nominal",
      )
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual([
      "Open Chat",
      "Start a conversation",
      "Gateway",
      "Connect before chat, voice, and live status.",
      "Online",
      "All systems nominal",
    ]);
  });

  it("requires exact String fields and scans multiline helper expressions", () => {
    const source = `
      data class StringResource(val key: String)
      data class ResourceState(val statusText: StringResource)

      ResourceState(statusText = StringResource("resource_key"))

      fun errorText(failed: Boolean): String =
        if (failed) {
          "Failure"
        } else {
          nativeString("Ready")
        }

      fun helperText(value: String?): String =
        value
          ?: "Fallback"
    `;
    const findings = findUnlocalizedAndroidUiLiterals(
      source,
      "apps/android/app/src/main/java/ai/openclaw/app/ui/Example.kt",
    ).map((finding) => finding.source);

    expect(findings).toEqual(["Failure", "Fallback"]);
  });

  it("ignores preview fixtures", () => {
    expect(
      findUnlocalizedAndroidUiLiterals(
        'Text("Preview copy")',
        "apps/android/app/src/main/java/ai/openclaw/app/ui/design/ClawComponents.kt",
      ),
    ).toEqual([]);
  });

  it("scans Wear presentation sources but ignores Wear screenshot fixtures", () => {
    const source = `
      data class WearSession(val title: String)
      WearSession(title = "Current session")
    `;
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/wear/src/main/java/ai/openclaw/wear/WearViewModel.kt",
      ).map((finding) => finding.source),
    ).toContain("Current session");
    expect(
      findUnlocalizedAndroidUiLiterals(
        source,
        "apps/android/wear/src/main/java/ai/openclaw/wear/WearScreenshotMode.kt",
      ),
    ).toEqual([]);
  });

  it("scans flavor-specific activity surfaces", () => {
    expect(
      findUnlocalizedAndroidUiLiterals(
        'Text("Developer surface")',
        "apps/android/app/src/thirdParty/java/ai/openclaw/app/accessibility/AccessibilityDevActivity.kt",
      ).map((finding) => finding.source),
    ).toEqual(["Developer surface"]);
  });

  it.each([
    {
      name: "a quoted closing parenthesis",
      source: 'fun statusText(token: String = ")"): String = "Ready"',
      expected: [
        {
          line: 1,
          source: "Ready",
        },
      ],
    },
    {
      name: "an escaped quote before a closing delimiter",
      source: 'fun statusText(token: String = "\\")"): String = "Ready"',
      expected: [
        {
          line: 1,
          source: "Ready",
        },
      ],
    },
    {
      name: "a doubled backslash before the closing quote",
      source: 'fun statusText(token: String = "\\\\"): String = "Ready"',
      expected: [
        {
          line: 1,
          source: "Ready",
        },
      ],
    },
    {
      name: "a quoted closing brace in a helper body",
      source: 'fun statusText(): String { val marker = "}"; return "Ready" }',
      expected: [
        {
          line: 1,
          source: "Ready",
        },
      ],
    },
    {
      name: "quoted commas and delimiters in positional model arguments",
      source:
        'data class State(val metadata: List<String>, val statusText: String)\nState(listOf("a,b", ")").map { it }, "🦊 Ready, ) ] }")',
      expected: [
        {
          line: 2,
          source: "🦊 Ready, ) ] }",
        },
      ],
    },
    {
      name: "a default comparison after nested generic types",
      source:
        'data class State(val metadata: Map<String, List<Int>>, val enabled: Boolean = 1 < 2, val statusText: String)\nState(emptyMap(), true, "Ready")',
      expected: [
        {
          line: 2,
          source: "Ready",
        },
      ],
    },
    {
      name: "quoted newlines before the next helper declaration",
      source: 'fun statusText(): String = """First\nsecond"""\nfun helperText(): String = "Next"',
      expected: [
        {
          line: 1,
          source: "First\nsecond",
        },
        {
          line: 3,
          source: "Next",
        },
      ],
    },
    {
      name: "an unclosed quoted parameter",
      source: 'fun statusText(token: String = "unterminated): String = "Ready"',
      expected: [],
    },
  ])("keeps scanner boundaries for $name", ({ source, expected }) => {
    const repoPath = "apps/android/app/src/main/java/ai/openclaw/app/ui/Scanner.kt";
    expect(findUnlocalizedAndroidUiLiterals(source, repoPath)).toEqual(
      expected.map((finding) => ({ ...finding, path: repoPath })),
    );
  });
});
