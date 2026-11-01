import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import * as apple from "../../scripts/apple-app-i18n.ts";
import { parseNativeI18nInventory } from "../../scripts/native-i18n-inventory.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";
import { decodeXml } from "../../src/shared/xml.ts";

const readInventory = async () =>
  parseNativeI18nInventory(await readFile("apps/.i18n/native-source.json", "utf8"));
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
function artifact(translations: Record<string, string>, locale = "fr") {
  return { version: 2, locale, translations };
}
function sourceOnlyInfoPlistFixture(source: string) {
  return [...source.matchAll(/<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/gu)]
    .map((match) => ({
      key: decodeXml(match[1] ?? ""),
      source: decodeXml(match[2] ?? ""),
    }))
    .flatMap((entry) =>
      entry.key.endsWith("UsageDescription") || entry.key === "NSScreenCaptureDescription"
        ? [
            `/* OpenClaw source: ${JSON.stringify(entry.source)} */`,
            `${JSON.stringify(entry.key)} = ${JSON.stringify(entry.source)};`,
          ]
        : [],
    )
    .join("\n")
    .concat("\n");
}

const probe = vi.hoisted(() => ({
  source: "",
  catalogs: new Map<string, string | Error>(),
  missingNativeLocales: new Set<string>(),
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
      const catalog = probe.catalogs.get(path.resolve(file));
      if (catalog instanceof Error) {
        throw catalog;
      }
      const source = catalog ?? (await actual.readFile(...args));
      return probe.source &&
        typeof source === "string" &&
        probe.paths.some((entry) => file.endsWith("/" + entry))
        ? source + "\n" + probe.source
        : source;
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (typeof args[0] !== "string") {
        return actual.readdir(...args);
      }
      const directoryPath = args[0];
      const directory = path.resolve(directoryPath);
      if (directory !== path.resolve("apps/.i18n/native")) {
        return actual.readdir(...args);
      }
      const entries = await actual.readdir(directoryPath, {
        withFileTypes: true,
        encoding: "utf8",
      });
      const names = new Set(entries.map((entry) => entry.name));
      const fixtureEntries = [...probe.catalogs.keys()]
        .filter((file) => path.dirname(file) === directory && file.endsWith(".json"))
        .map((file) => path.basename(file))
        .filter((name) => !names.has(name))
        .map((name) => ({
          name,
          parentPath: directoryPath,
          isFile: () => true,
          isDirectory: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isSymbolicLink: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        }));
      return [...entries, ...fixtureEntries].filter((entry) => {
        const locale = entry.name.replace(/\.json$/u, "");
        return !probe.missingNativeLocales.has(locale);
      });
    },
  };
});

it("verification and compile-macos reject raw macOS interpolation and retain shared/iOS coverage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-runtime-"));
  const output = path.join(root, "output");
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
  } finally {
    probe.source = "";
    await rm(root, { recursive: true, force: true });
  }
});

it("verifies and compiles source when a generated native locale is not yet present", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-source-only-"));
  const output = path.join(root, "output");
  const localePath = path.resolve("apps/.i18n/native/pt-PT.json");
  probe.missingNativeLocales.add("pt-PT");
  probe.catalogs.set(
    localePath,
    Object.assign(new Error("source-only checkout has no PT-PT native artifact"), {
      code: "ENOENT",
    }),
  );
  try {
    await expect(apple.verifyAppleAppI18n()).resolves.toBeUndefined();
    await expect(apple.compileMacosLocalizations(output)).resolves.toBeUndefined();
    await expect(apple.checkAppleAppI18n()).rejects.toThrow("Apple/native locale parity drift");
    const english = await readFile(path.join(output, "en.lproj", "Localizable.strings"), "utf8");
    expect(english).toContain('"About OpenClaw" = "About OpenClaw";');
  } finally {
    probe.missingNativeLocales.clear();
    probe.catalogs.delete(localePath);
    await rm(root, { recursive: true, force: true });
  }
});

it("warns only when obsolete Apple keys are the entire catalog drift", async () => {
  const ptPtArtifactPath = path.resolve("apps/.i18n/native/pt-PT.json");
  try {
    const inventory = await readInventory();
    probe.catalogs.set(
      ptPtArtifactPath,
      JSON.stringify(
        artifact(Object.fromEntries(inventory.map((entry) => [entry.id, entry.source])), "pt-PT"),
      ),
    );
    const translations = await Promise.all(
      NATIVE_I18N_LOCALES.map(async (locale) =>
        JSON.parse(await readFile(`apps/.i18n/native/${locale}.json`, "utf8")),
      ),
    );
    for (const [sourcePath, outputPath] of [
      ["apps/ios/Sources/Info.plist", "apps/ios/Sources/pt-PT.lproj/InfoPlist.strings"],
      ["apps/ios/WatchApp/Info.plist", "apps/ios/WatchApp/pt-PT.lproj/InfoPlist.strings"],
      [
        "apps/ios/ShareExtension/Info.plist",
        "apps/ios/ShareExtension/pt-PT.lproj/InfoPlist.strings",
      ],
      [
        "apps/ios/ActivityWidget/Info.plist",
        "apps/ios/ActivityWidget/pt-PT.lproj/InfoPlist.strings",
      ],
    ] as const) {
      probe.catalogs.set(
        path.resolve(outputPath),
        sourceOnlyInfoPlistFixture(await readFile(sourcePath, "utf8")),
      );
    }
    const catalogs = await Promise.all(
      Object.entries({
        "apps/ios/Resources/Localizable.xcstrings": apple.buildIosCatalog,
        "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings": apple.buildMacosCatalog,
      }).map(async ([file, buildCatalog]) => {
        const filePath = path.resolve(file);
        const existing = JSON.parse(await readFile(filePath, "utf8"));
        return { filePath, catalog: buildCatalog(existing, inventory, translations).catalog };
      }),
    );
    for (const { filePath, catalog } of catalogs) {
      probe.catalogs.set(filePath, apple.serializeAppleCatalog(catalog));
    }
    for (const { filePath, catalog } of catalogs) {
      const warnings: string[] = [];
      const options = { reportObsolete: (message: string) => warnings.push(message) };
      const strings = expectDefined(catalog.strings, "active catalog strings");
      const activeKey = expectDefined(
        Object.keys(strings).find((key) => key.includes("%@")),
        "active format key",
      );
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
      const reject = async (invalid: string) => {
        probe.catalogs.set(filePath, invalid);
        await expect(apple.checkAppleAppI18n(options)).rejects.toThrow();
      };
      probe.catalogs.set(filePath, serialized);
      await expect(apple.checkAppleAppI18n()).rejects.toThrow("is stale");
      await expect(apple.checkAppleAppI18n(options)).resolves.toBeUndefined();
      expect(warnings).toEqual([
        `Apple obsolete catalog rows: ${path.relative(process.cwd(), filePath).replaceAll("\\", "/")} (keys=2)`,
      ]);

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
        await reject(serialized.replace(`"${retired}": {}`, `"${retired}": ${row}`));
      }

      const mutate = (change: (copy: typeof obsolete, row: (typeof strings)[string]) => void) => {
        const copy = structuredClone(obsolete);
        change(copy, expectDefined(copy.strings[activeKey], "active catalog entry"));
        return apple.serializeAppleCatalog(copy);
      };
      for (const invalid of [
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
      ]) {
        await reject(invalid);
      }
      probe.catalogs.set(filePath, apple.serializeAppleCatalog(catalog));
    }
  } finally {
    probe.catalogs.clear();
  }
});

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
