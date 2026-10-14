import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import {
  buildIosCatalog,
  buildMacosCatalog,
  compileMacosLocalizations,
  checkAppleAppI18n,
  findAmbiguousRuntimeInterpolations,
  infoPlistTranslationCandidates,
  selectInfoPlistTranslation,
  serializeAppleCatalog,
  verifyAppleAppI18n,
} from "../../scripts/apple-app-i18n.ts";
import {
  type NativeI18nInventoryEntry,
  parseNativeI18nInventory,
} from "../../scripts/native-i18n-inventory.ts";
import { NATIVE_I18N_LOCALES } from "../../scripts/native-i18n-locales.ts";

const probe = vi.hoisted(() => ({
  source: "",
  catalogs: new Map<string, string>(),
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
      if (catalog !== undefined) {
        return catalog;
      }
      const source = await actual.readFile(...args);
      return probe.source &&
        typeof source === "string" &&
        probe.paths.some((entry) => file.endsWith("/" + entry))
        ? source + "\n" + probe.source
        : source;
    },
  };
});

describe("Apple app i18n catalogs", () => {
  it("verification and compile-macos reject raw macOS interpolation and retain shared/iOS coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-runtime-"));
    const output = path.join(root, "output");
    const gates = [() => verifyAppleAppI18n(), () => compileMacosLocalizations(output)];
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
      expect(english).toContain('"Expires in %lld minutes" = "Expires in %lld minutes";');
      expect(english).toContain(
        '"^[%lld message](inflect: true)" = "^[%lld message](inflect: true)";',
      );
    } finally {
      probe.source = "";
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives shared discovery status coverage into the iOS catalog", async () => {
    const inventory = parseNativeI18nInventory(
      await readFile("apps/.i18n/native-source.json", "utf8"),
    );
    const build = buildIosCatalog(
      { sourceLanguage: "en", strings: {}, version: "1.0" },
      inventory,
      [],
    );

    expect(Object.keys(build.catalog.strings ?? {})).toEqual(
      expect.arrayContaining(["Searching…", "Stopped", "Waiting"]),
    );
  });

  it("warns only when obsolete Apple keys are the entire catalog drift", async () => {
    const inventory = parseNativeI18nInventory(
      await readFile("apps/.i18n/native-source.json", "utf8"),
    );
    const translations = await Promise.all(
      NATIVE_I18N_LOCALES.map(async (locale) =>
        JSON.parse(await readFile(`apps/.i18n/native/${locale}.json`, "utf8")),
      ),
    );
    const catalogs = await Promise.all(
      (
        [
          ["apps/ios/Resources/Localizable.xcstrings", buildIosCatalog],
          ["apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings", buildMacosCatalog],
        ] as const
      ).map(async ([file, buildCatalog]) => {
        const filePath = path.resolve(file);
        const build = buildCatalog(
          JSON.parse(await readFile(filePath, "utf8")),
          inventory,
          translations,
        );
        return { filePath, catalog: build.catalog };
      }),
    );
    try {
      // Source PRs can await generation; keep this fixture's active resources current.
      for (const { filePath, catalog } of catalogs) {
        probe.catalogs.set(filePath, serializeAppleCatalog(catalog));
      }
      for (const { filePath, catalog } of catalogs) {
        const warnings: string[] = [];
        const options = { reportObsolete: (message: string) => warnings.push(message) };
        const strings = expectDefined(catalog.strings, "active catalog strings");
        const activeKey = expectDefined(
          Object.keys(strings).find((key) => key.includes("%@")),
          "active format key",
        );
        const obsolete: typeof catalog & { strings: typeof strings } = {
          ...catalog,
          strings: {
            ...strings,
            "Retired synthetic %@": {
              localizations: { en: { stringUnit: { state: "new", value: "" } } },
            },
            "Retired empty title": {},
          },
        };
        const serialized = serializeAppleCatalog(obsolete);
        probe.catalogs.set(filePath, serialized);
        await expect(checkAppleAppI18n()).rejects.toThrow("is stale");
        warnings.length = 0;
        await expect(checkAppleAppI18n(options)).resolves.toBeUndefined();
        expect(warnings).toEqual([
          `Apple obsolete catalog rows: ${path.relative(process.cwd(), filePath).replaceAll("\\", "/")} (keys=2)`,
        ]);

        for (const ineligibleRow of [
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
          probe.catalogs.set(
            filePath,
            serialized.replace(
              '"Retired empty title": {}',
              `"Retired empty title": ${ineligibleRow}`,
            ),
          );
          await expect(checkAppleAppI18n(options)).rejects.toThrow();
        }

        const missingKey = structuredClone(obsolete);
        delete missingKey.strings[activeKey];
        const missingLocale = structuredClone(obsolete);
        delete missingLocale.strings[activeKey]?.localizations?.de;
        const placeholderDrift = structuredClone(obsolete);
        expectDefined(
          placeholderDrift.strings[activeKey]?.localizations?.de?.stringUnit,
          "German format unit",
        ).value = "Missing format argument";
        const metadataDrift = structuredClone(obsolete);
        expectDefined(metadataDrift.strings[activeKey], "active catalog entry").comment =
          "Unexpected metadata";
        for (const invalid of [
          serializeAppleCatalog(missingKey),
          serializeAppleCatalog(missingLocale),
          serializeAppleCatalog(placeholderDrift),
          serializeAppleCatalog(metadataDrift),
          serializeAppleCatalog({ ...obsolete, sourceLanguage: "fr" }),
          serializeAppleCatalog({ ...obsolete, version: "2.0" }),
          `${serialized}\n`,
          `${serialized}malformed\n`,
        ]) {
          probe.catalogs.set(filePath, invalid);
          await expect(checkAppleAppI18n(options)).rejects.toThrow();
        }
        probe.catalogs.set(filePath, serializeAppleCatalog(catalog));
      }
    } finally {
      probe.catalogs.clear();
    }
  });

  it("routes merged sites by coupled path and kind while preserving shipped translations", () => {
    const coveredMacosEntries: NativeI18nInventoryEntry[] = [
      { kind: "ui-call-concatenated", source: "Call concatenated" },
      {
        kind: "ui-localized-call-concatenated",
        source:
          "Older generated approvals are inactive because they were not tied to a working directory. Manual rules are unchanged.",
      },
      { kind: "ui-modifier-concatenated", source: "Modifier concatenated" },
      { kind: "ui-modifier-multiline", source: "Modifier multiline" },
      { kind: "ui-named-argument-concatenated", source: "Named argument concatenated" },
    ].map(({ kind, source }, index) => ({
      id: `native.apple.concatenated.${index}`,
      source,
      surface: "apple",
      sites: [{ kind, path: "apps/macos/Sources/OpenClaw/Example.swift" }],
    }));
    const inventory: NativeI18nInventoryEntry[] = [
      {
        id: "native.apple.connect",
        source: "Connect now",
        surface: "apple",
        sites: [
          { kind: "ui-call", path: "apps/ios/Sources/Example.swift" },
          { kind: "ui-call", path: "apps/macos/Sources/OpenClaw/Example.swift" },
        ],
      },
      {
        id: "native.apple.decoy",
        source: "Do not catalog",
        surface: "apple",
        sites: [
          { kind: "plist-string", path: "apps/ios/Sources/Info.plist" },
          { kind: "ui-call", path: "outside/Example.swift" },
        ],
      },
      ...coveredMacosEntries,
    ];
    const existing = {
      sourceLanguage: "en",
      strings: {
        "Connect now": {
          localizations: {
            de: { stringUnit: { state: "translated", value: "Jetzt verbinden" } },
          },
        },
      },
    };
    const translations = [
      {
        version: 2,
        locale: "fr",
        translations: { "native.apple.connect": "Se connecter" },
      },
    ];
    const ios = buildIosCatalog(existing, inventory, translations);
    const macos = buildMacosCatalog({ sourceLanguage: "en", strings: {} }, inventory, translations);

    expect(ios.catalog.strings?.["Connect now"]?.localizations?.de?.stringUnit?.value).toBe(
      "Jetzt verbinden",
    );
    expect(ios.catalog.strings?.["Connect now"]?.localizations?.fr?.stringUnit).toEqual({
      state: "translated",
      value: "Se connecter",
    });
    expect(ios.catalog.strings?.["Connect now"]?.localizations?.es?.stringUnit).toEqual({
      state: "new",
      value: "Connect now",
    });
    expect(ios.catalog.strings?.["Do not catalog"]).toBeUndefined();
    expect(macos.catalog.strings?.["Connect now"]).toBeDefined();
    expect(Object.keys(macos.catalog.strings ?? {})).toEqual(
      expect.arrayContaining(coveredMacosEntries.map((entry) => entry.source)),
    );
    expect(macos.catalog.strings?.["Do not catalog"]).toBeUndefined();
    expect(ios.contradictions).toEqual([]);
  });

  it("rejects interpolated runtime copy across every supported Swift syntax", () => {
    const source = String.raw`
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
    `;

    expect(findAmbiguousRuntimeInterpolations(source)).toEqual([
      "interpolated localized resource",
      "interpolated multiline localized resource",
      "interpolated SwiftUI text literal",
      "interpolated multiline SwiftUI text literal",
      "interpolated multiline SwiftUI modifier literal",
    ]);
  });

  it("refreshes InfoPlist copy from translations for the current source", () => {
    expect(
      selectInfoPlistTranslation(
        "Use the camera to scan setup codes.",
        ["Utilisez l’appareil photo pour scanner les codes de configuration."],
        {
          source: "Old camera purpose.",
          value: "Ancienne description de la caméra.",
        },
      ),
    ).toBe("Utilisez l’appareil photo pour scanner les codes de configuration.");
    expect(
      selectInfoPlistTranslation("OpenClaw Share", [], {
        source: "OpenClaw Share",
        value: "OpenClaw Partager",
      }),
    ).toBe("OpenClaw Partager");
    expect(
      selectInfoPlistTranslation(
        "Use the camera to scan setup codes.",
        ["Use the camera to scan setup codes."],
        {
          source: "Use the camera to scan setup codes.",
          value: "Utilisez l’appareil photo pour scanner les codes de configuration.",
        },
      ),
    ).toBe("Utilisez l’appareil photo pour scanner les codes de configuration.");
    expect(
      selectInfoPlistTranslation("Use the camera for video calls.", [], {
        source: "Use the camera to scan setup codes.",
        value: "Utilisez l’appareil photo pour scanner les codes de configuration.",
      }),
    ).toBe("Use the camera for video calls.");
  });

  it("selects InfoPlist candidates by stable ID instead of shared source text", () => {
    const artifact = {
      version: 2,
      locale: "fr",
      translations: {
        "native.apple.camera": "Utilisez l’appareil photo pour scanner les codes de configuration.",
        "native.apple.unrelated": "Traduction pour un autre contexte.",
      },
    };

    expect(infoPlistTranslationCandidates(artifact, "native.apple.camera")).toEqual([
      "Utilisez l’appareil photo pour scanner les codes de configuration.",
    ]);
  });
});
