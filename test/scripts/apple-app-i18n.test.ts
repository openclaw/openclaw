import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFailed, vi } from "vitest";
import * as apple from "../../scripts/apple-app-i18n.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";
import { decodeXml } from "../../src/shared/xml.ts";

type Entry = Parameters<typeof apple.buildIosCatalog>[1][number];
const emptyCatalog = { sourceLanguage: "en", strings: {}, version: "1.0" };
const unit = (value: string, state = "translated") => ({ stringUnit: { state, value } });
const [cameraSource, cameraTranslation] = ["Camera", "Caméra"];
const site = (kind: string, platform: "ios" | "macos") => ({
  kind,
  path: `apps/${platform}/Sources/${platform === "macos" ? "OpenClaw/" : ""}Example.swift`,
});
function makeEntry(id: string, source: string, sites: Entry["sites"]): Entry {
  return { id: `native.apple.${id}`, source, surface: "apple", sites };
}
function artifact(translations: Record<string, string>) {
  return { version: 2, locale: "fr", translations };
}

const probe = vi.hoisted(() => ({
  source: "",
  nativeTranslationFixture: "",
  catalogs: new Map<string, string>(),
  captureWrites: false,
  paths: [
    "apps/macos/Sources/OpenClaw/OnboardingAISetupView.swift",
    "apps/ios/Sources/Gateway/ExecApprovalPromptDialog.swift",
    "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatComposer+Controls.swift",
    "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayDiscoveryStatusText.swift",
  ],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Synthetic calls are opt-in and limited to production-source reads; all other I/O stays real.
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const file = typeof args[0] === "string" ? args[0].replaceAll("\\", "/") : "";
      const source = probe.catalogs.get(path.resolve(file)) ?? (await actual.readFile(...args));
      return probe.source &&
        typeof source === "string" &&
        probe.paths.some((entry) => file.endsWith("/" + entry))
        ? source + "\n" + probe.source
        : source;
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      const directory = typeof args[0] === "string" ? path.resolve(args[0]) : "";
      if (directory === path.resolve("apps/.i18n/native") && probe.nativeTranslationFixture) {
        return actual.readdir(probe.nativeTranslationFixture, { withFileTypes: true });
      }
      return actual.readdir(...args);
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (probe.captureWrites && typeof args[0] === "string" && typeof args[1] === "string") {
        probe.catalogs.set(path.resolve(args[0]), args[1]);
        return;
      }
      await actual.writeFile(...args);
    },
  };
});

const appleLocaleDirectories: Readonly<Record<string, string>> = {
  "ja-JP": "ja",
  "zh-CN": "zh-Hans",
  "zh-TW": "zh-Hant",
};

async function installNativeTranslationFixture(missingLocale?: string) {
  probe.catalogs.clear();
  probe.nativeTranslationFixture = "";
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-native-i18n-"));
  const directory = path.join(root, "native");
  await mkdir(directory);
  for (const locale of NATIVE_I18N_LOCALES) {
    if (locale === missingLocale) {
      continue;
    }
    const fixtureArtifact = {
      glossaryHash: "synthetic-fixture",
      locale,
      translations: {},
      version: 2,
    };
    const contents = JSON.stringify(fixtureArtifact);
    await writeFile(path.join(directory, `${locale}.json`), contents);
    probe.catalogs.set(path.resolve(`apps/.i18n/native/${locale}.json`), contents);
  }
  probe.nativeTranslationFixture = directory;
  return root;
}

async function installInfoPlistOutputFixtures() {
  const sourcePaths = [
    "apps/ios/Sources/Info.plist",
    "apps/ios/WatchApp/Info.plist",
    "apps/ios/ShareExtension/Info.plist",
    "apps/ios/ActivityWidget/Info.plist",
  ];
  for (const sourcePath of sourcePaths) {
    const source = await readFile(sourcePath, "utf8");
    const entries = [...source.matchAll(/<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)]
      .map((match) => ({
        key: decodeXml(match[1] ?? ""),
        source: decodeXml(match[2] ?? ""),
      }))
      .filter(
        ({ key }) => key.endsWith("UsageDescription") || key === "NSScreenCaptureDescription",
      );
    const contents = `${entries
      .map(({ key, source: sourceValue }) =>
        [
          `/* OpenClaw source: ${JSON.stringify(sourceValue)} */`,
          `${JSON.stringify(key)} = ${JSON.stringify(sourceValue)};`,
        ].join("\n"),
      )
      .join("\n")}\n`;
    for (const locale of NATIVE_I18N_LOCALES) {
      const localeDirectory = appleLocaleDirectories[locale] ?? locale;
      probe.catalogs.set(
        path.resolve(path.dirname(sourcePath), `${localeDirectory}.lproj`, "InfoPlist.strings"),
        contents,
      );
    }
  }
}

async function removeNativeTranslationFixture(root: string) {
  probe.source = "";
  probe.nativeTranslationFixture = "";
  probe.catalogs.clear();
  await rm(root, { recursive: true, force: true });
}

it("verification and compile-macos reject raw macOS interpolation and retain shared/iOS coverage", async () => {
  const root = await installNativeTranslationFixture();
  const output = path.join(root, "output");
  await installInfoPlistOutputFixtures();
  const gates = [() => apple.verifyAppleAppI18n(), () => apple.compileMacosLocalizations(output)];
  try {
    probe.source = 'Label("Expires in \\(minutes) minutes", systemImage: "clock")';
    const diagnostic = [
      "Apple i18n runtime interpolation bypasses generated catalog coverage:",
      ...probe.paths
        .toSorted()
        .map((entry) => path.normalize(entry) + ": interpolated SwiftUI text literal"),
    ].join("\n");
    for (const gate of gates) {
      await expect(gate()).rejects.toThrow(new Error(diagnostic));
    }
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });

    probe.source = [
      "let minutes: Int = 3",
      'Label(String(format: String(localized: "Expires in %lld minutes"), minutes), systemImage: "clock")',
      'Text(verbatim: "\\(name) — \\(minutes)")',
      "let count: Int = 2",
      'String(AttributedString(localized: "^[\\(count) message](inflect: true)").characters)',
    ].join("\n");
    for (const gate of gates) {
      await expect(gate()).resolves.toBeUndefined();
    }
    const english = await readFile(path.join(output, "en.lproj", "Localizable.strings"), "utf8");
    for (const key of ["Expires in %lld minutes", "^[%lld message](inflect: true)"]) {
      expect(english).toContain(`"${key}" = "${key}";`);
    }
    await expect(readdir(path.join(output, "fr.lproj"))).resolves.toEqual(
      expect.arrayContaining(["Localizable.strings", "InfoPlist.strings"]),
    );
  } finally {
    await removeNativeTranslationFixture(root);
  }
});

it("verifies source without a missing locale artifact while strict Apple paths reject it", async () => {
  const root = await installNativeTranslationFixture("fr");
  const output = path.join(root, "missing-output");
  try {
    await expect(apple.verifyAppleAppI18n()).resolves.toBeUndefined();
    await expect(apple.checkAppleAppI18n()).rejects.toThrow("Apple/native locale parity drift");
    await expect(apple.compileMacosLocalizations(output)).rejects.toThrow(
      "Apple/native locale parity drift",
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await removeNativeTranslationFixture(root);
  }
});

it("checks both app catalogs through the public strict and obsolete-warning paths", async () => {
  const stages: Array<{ stage: string; started: number; finished?: number }> = [];
  const startStage = (stage: string) => {
    const record: (typeof stages)[number] = { stage, started: performance.now() };
    if (stages.length < 45) {
      stages.push(record);
    }
    return () => {
      record.finished = performance.now();
    };
  };
  // Keep failure diagnostics bounded without wrapping or rescheduling the real checks.
  onTestFailed(() => {
    const observedAt = performance.now();
    console.error(
      "Apple catalog drift stages:",
      JSON.stringify(
        stages.map(({ stage, started, finished }) => ({
          stage,
          elapsedMs: Math.round((finished ?? observedAt) - started),
          completed: finished !== undefined,
        })),
      ),
    );
  });
  const root = await installNativeTranslationFixture();
  try {
    // Source PRs defer generated locale files; normalize all sibling artifacts in memory.
    probe.captureWrites = true;
    const finishSync = startStage("sync");
    const { build, macosBuild } = await apple.syncAppleAppI18n();
    finishSync();
    for (const [platform, filePath, catalog] of [
      ["ios", path.resolve("apps/ios/Resources/Localizable.xcstrings"), build.catalog],
      [
        "macos",
        path.resolve("apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings"),
        macosBuild.catalog,
      ],
    ] as const) {
      const finishPrepare = startStage(`${platform}:prepare`);
      probe.catalogs.set(
        filePath,
        apple.serializeAppleCatalog({
          ...catalog,
          strings: { ...catalog.strings, "Retired empty title": {} },
        }),
      );
      finishPrepare();
      const finishStrict = startStage(`${platform}:strict-stale`);
      await expect(apple.checkAppleAppI18n()).rejects.toThrow("is stale");
      finishStrict();
      const finishWarning = startStage(`${platform}:obsolete-warning`);
      const warnings: string[] = [];
      await expect(
        apple.checkAppleAppI18n({ reportObsolete: (message) => warnings.push(message) }),
      ).resolves.toBeUndefined();
      expect(warnings).toEqual([
        `Apple obsolete catalog rows: ${path.relative(process.cwd(), filePath).replaceAll("\\", "/")} (keys=1)`,
      ]);
      finishWarning();
      const finishRestore = startStage(`${platform}:restore`);
      probe.catalogs.set(filePath, apple.serializeAppleCatalog(catalog));
      finishRestore();
    }
  } finally {
    probe.captureWrites = false;
    await removeNativeTranslationFixture(root);
  }
});

it.each(["ios", "macos"] as const)(
  "warns only when obsolete %s keys are the entire catalog drift",
  (platform) => {
    const buildCatalog = platform === "ios" ? apple.buildIosCatalog : apple.buildMacosCatalog;
    const inventory = [makeEntry("format", "Active %@", [site("ui-call", platform)])];
    const { catalog } = buildCatalog(emptyCatalog, inventory, []);
    const strings = expectDefined(catalog.strings, "active catalog strings");
    const activeKey = "Active %@";
    const active = expectDefined(strings[activeKey], "active catalog entry");
    expectDefined(active.localizations, "active localizations").de = unit("Aktiv %@");
    const retired = "Retired empty title";
    const obsolete: typeof catalog & { strings: typeof strings } = {
      ...catalog,
      strings: {
        ...strings,
        "Retired synthetic %@": { localizations: { en: unit("", "new") } },
        [retired]: {},
      },
    };
    const serialized = apple.serializeAppleCatalog(obsolete);
    const warnings: string[] = [];
    const reportObsolete = (message: string) => warnings.push(message);
    const check = (actual: string, report?: (message: string) => void) => {
      // Rebuild from each input: translated units survive generation and must still pass
      // semantic validation after comparison, just as in the public check.
      const build = buildCatalog(JSON.parse(actual) as typeof catalog, inventory, []);
      apple.assertAppleCatalogCurrent(platform, actual, build.catalog, report);
      apple.validateAppleCatalog(platform, build.catalog);
    };
    expect(() => check(serialized)).toThrow("is stale");
    expect(() => check(serialized, reportObsolete)).not.toThrow();
    expect(warnings).toEqual([`Apple obsolete catalog rows: ${platform} (keys=2)`]);

    for (const row of [
      "null",
      "42",
      '{"localizations":null}',
      '{"localizations":{"en":42}}',
      '{"localizations":{"en":{"stringUnit":null}}}',
      '{"localizations":{"en":{"stringUnit":{"state":"new"}}}}',
      '{"localizations":{"en":{"stringUnit":{"state":42,"value":"Retired"}}}}',
      '{"comment":42}',
      '{"localizations":{"en":{"variations":{}}}}',
    ]) {
      expect(() =>
        check(serialized.replace(`"${retired}": {}`, `"${retired}": ${row}`), reportObsolete),
      ).toThrow();
    }

    const mutate = (change: (copy: typeof obsolete, row: (typeof strings)[string]) => void) => {
      const copy = structuredClone(obsolete);
      change(copy, expectDefined(copy.strings[activeKey], "active catalog entry"));
      return apple.serializeAppleCatalog(copy);
    };
    const invalidCatalogs = [
      mutate((copy) => delete copy.strings[activeKey]),
      mutate((_copy, row) => delete row.localizations?.de),
      mutate((_copy, row) => {
        expectDefined(row.localizations?.de?.stringUnit, "German format unit").value =
          "Missing format argument";
      }),
      mutate((_copy, row) => Object.assign(row, { comment: "Unexpected metadata" })),
      apple.serializeAppleCatalog({ ...obsolete, sourceLanguage: "fr" }),
      apple.serializeAppleCatalog({ ...obsolete, version: "2.0" }),
      `${serialized}\n`,
      `${serialized}malformed\n`,
    ];
    for (const invalid of invalidCatalogs) {
      expect(() => check(invalid, reportObsolete)).toThrow();
    }

    const translated = structuredClone(catalog);
    expectDefined(
      translated.strings?.[activeKey]?.localizations?.de?.stringUnit,
      "translated German unit",
    ).value = "Anderer gültiger %@";
    expect(() => check(apple.serializeAppleCatalog(translated))).not.toThrow();
    expect(() =>
      check(
        apple.serializeAppleCatalog({
          ...obsolete,
          strings: {
            ...obsolete.strings,
            [activeKey]: expectDefined(translated.strings?.[activeKey], "translated entry"),
          },
        }),
        reportObsolete,
      ),
    ).not.toThrow();

    const invalidTranslation = structuredClone(translated);
    expectDefined(
      invalidTranslation.strings?.[activeKey]?.localizations?.de?.stringUnit,
      "translated German unit",
    ).value = "Missing format argument";
    const invalidBuild = buildCatalog(invalidTranslation, inventory, []);
    // A translated value can be current byte-for-byte and still violate placeholders.
    expect(() =>
      apple.assertAppleCatalogCurrent(
        platform,
        apple.serializeAppleCatalog(invalidTranslation),
        invalidBuild.catalog,
      ),
    ).not.toThrow();
    expect(() => apple.validateAppleCatalog(platform, invalidBuild.catalog)).toThrow(
      "placeholder drift in de",
    );
  },
);

it("routes merged sites by coupled path and kind while preserving shipped translations", () => {
  const coveredMacosEntries: Entry[] = [
    "ui-call-concatenated",
    "ui-localized-call-concatenated",
    "ui-modifier-concatenated",
    "ui-modifier-multiline",
    "ui-named-argument-concatenated",
  ].map((kind, index) =>
    makeEntry(`concatenated.${index}`, `Concatenated ${index}`, [site(kind, "macos")]),
  );
  const inventory: Entry[] = [
    makeEntry("connect", "Connect now", [site("ui-call", "ios"), site("ui-call", "macos")]),
    makeEntry("decoy", "Do not catalog", [
      { kind: "plist-string", path: "apps/ios/Sources/Info.plist" },
      { kind: "ui-call", path: "outside/Example.swift" },
    ]),
    ...coveredMacosEntries,
  ];
  const existing = {
    ...emptyCatalog,
    strings: {
      "Connect now": { localizations: { de: unit("Jetzt verbinden") } },
    },
  };
  const translations = [artifact({ "native.apple.connect": "Se connecter" })];
  const ios = apple.buildIosCatalog(existing, inventory, translations);
  const macos = apple.buildMacosCatalog(emptyCatalog, inventory, translations);

  const localized = ios.catalog.strings?.["Connect now"]?.localizations;
  expect(localized?.de?.stringUnit?.value).toBe("Jetzt verbinden");
  expect([localized?.fr?.stringUnit, localized?.es?.stringUnit]).toEqual([
    unit("Se connecter").stringUnit,
    unit("Connect now", "new").stringUnit,
  ]);
  expect(ios.catalog.strings?.["Do not catalog"]).toBeUndefined();
  expect(macos.catalog.strings?.["Connect now"]).toBeDefined();
  expect(Object.keys(macos.catalog.strings ?? {})).toEqual(
    expect.arrayContaining(coveredMacosEntries.map((item) => item.source)),
  );
  expect(macos.catalog.strings?.["Do not catalog"]).toBeUndefined();
  expect(ios.contradictions).toEqual([]);
});

it("rejects interpolated runtime copy across every supported Swift syntax", () => {
  expect(
    apple.findAmbiguousRuntimeInterpolations(String.raw`
      let key = LocalizedStringKey("Hello \(name)")
      let detail = String(localized: """
        Welcome \(name)
        """)
      Toggle("Enable \(feature)", isOn: $enabled)
      Menu("""
        Open \(item)
        """) {}
      view.accessibilityHint("""
        Select \(item)
        """)
    `),
  ).toEqual([
    "interpolated localized resource",
    "interpolated multiline localized resource",
    "interpolated SwiftUI text literal",
    "interpolated multiline SwiftUI text literal",
    "interpolated multiline SwiftUI modifier literal",
  ]);
});

it.each<[string, string[], string, string, string]>([
  [cameraSource, [cameraTranslation], "Old camera", "Ancienne caméra", cameraTranslation],
  ["Share", [], "Share", "Partager", "Partager"],
  [cameraSource, [cameraSource], cameraSource, cameraTranslation, cameraTranslation],
  ["Video camera", [], cameraSource, cameraTranslation, "Video camera"],
])("refreshes InfoPlist %s", (source, candidates, old, value, expected) => {
  expect(apple.selectInfoPlistTranslation(source, candidates, { source: old, value })).toBe(
    expected,
  );
});

it("selects InfoPlist candidates by stable ID instead of shared source text", () => {
  const translations = artifact({
    "native.apple.camera": cameraTranslation,
    "native.apple.unrelated": "Autre",
  });
  expect(apple.infoPlistTranslationCandidates(translations, "native.apple.camera")).toEqual([
    cameraTranslation,
  ]);
});
