import { describe, expect, it } from "vitest";

const { assertNativeGeneratedArtifactsIsolated, shouldRunNativeI18n, shouldStrictNativeI18n } =
  await import("../../scripts/ci-changed-scope.mjs");

const nativeSource = "apps/.i18n/native-source.json";
const androidLookup =
  "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt";
const mainActivity = "apps/android/app/src/main/java/ai/openclaw/app/MainActivity.kt";
const canonicalArtifacts = [
  "apps/.i18n/native/sv.json",
  "apps/android/app/src/main/res/values-sv/strings.xml",
  "apps/android/wear/src/main/res/values-sv/strings.xml",
  "apps/ios/Resources/Localizable.xcstrings",
  "apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings",
];
const sharedOwners = [
  "scripts/ci-changed-scope.mjs",
  "scripts/native-app-i18n.ts",
  "scripts/android-app-i18n.ts",
  "test/scripts/native-app-i18n.test.ts",
  "src/scripts/ci-changed-scope.native-i18n.test.ts",
];

function expectAllowed(paths: string[], branch?: string) {
  expect(() => assertNativeGeneratedArtifactsIsolated(paths, branch)).not.toThrow();
}

function expectMixed(paths: string[]) {
  expect(() => assertNativeGeneratedArtifactsIsolated(paths)).toThrow(
    "Native generated locale artifacts must be isolated from source changes",
  );
}

describe("native i18n changed scope", () => {
  it.each(["scripts/native-app-i18n.ts", "scripts/native-i18n-inventory.ts"])(
    "routes %s without requiring generated parity",
    (sourcePath) => {
      expect(shouldRunNativeI18n([sourcePath])).toBe(true);
      expect(shouldStrictNativeI18n([sourcePath])).toBe(false);
    },
  );

  it("routes Android flavor sources through native i18n", () => {
    expect(
      shouldRunNativeI18n([
        "apps/android/app/src/play/java/ai/openclaw/app/PlayBilling.kt",
        "apps/android/app/src/thirdParty/res/values/accessibility_strings.xml",
      ]),
    ).toBe(true);
  });

  it("keeps generated artifacts in isolated automation PRs", () => {
    const generatedCompanionPaths = [
      "apps/android/app/src/main/res/values/strings.xml",
      "apps/android/app/src/main/res/values/assistant.xml",
    ];
    const generatedPaths = [
      ...canonicalArtifacts,
      androidLookup,
      "apps/android/app/src/thirdParty/res/values-sv/accessibility_strings.xml",
      "apps/ios/WatchApp/sv.lproj/InfoPlist.strings",
    ];

    expectAllowed(generatedPaths);
    expectAllowed([...generatedPaths, ...generatedCompanionPaths]);
    expectMixed([...generatedPaths, nativeSource]);
    expectAllowed([...generatedPaths, "apps/ios/Sources/RootTabs.swift"], "main");
    expectAllowed([...generatedCompanionPaths, nativeSource]);
    expectMixed([...generatedPaths, ...generatedCompanionPaths, nativeSource]);
    expectMixed([...generatedPaths, ...generatedCompanionPaths, mainActivity]);
  });

  it("allows only the owner-complete one-time native v2 artifact migration", () => {
    const migration = [
      ".gitattributes",
      ...sharedOwners,
      "scripts/apple-app-i18n.ts",
      "test/scripts/apple-app-i18n.test.ts",
      nativeSource,
      ...canonicalArtifacts,
    ];

    expectAllowed(migration);
    expectMixed(migration.slice(1));
    expectMixed([...migration, androidLookup]);
  });

  it("runs strict parity only for manual or generated-artifact checks", () => {
    for (const paths of [
      null,
      ["apps/.i18n/native/sv.json"],
      ["apps/android/app/src/thirdParty/res/values-sv/accessibility_strings.xml"],
      ["apps/ios/Resources/Localizable.xcstrings"],
      ["apps/macos/Sources/OpenClaw/Resources/Localizable.xcstrings"],
    ]) {
      expect(shouldStrictNativeI18n(paths)).toBe(true);
    }
    expect(shouldStrictNativeI18n(["apps/ios/Sources/RootTabs.swift", nativeSource])).toBe(false);
  });

  it("admits the Android projection retirement only with its complete input migration", () => {
    const migration = [
      androidLookup,
      ".github/workflows/native-app-locale-refresh.yml",
      nativeSource,
      "apps/android/app/build.gradle.kts",
      ...sharedOwners,
      "test/scripts/android-app-i18n.test.ts",
      "apps/.i18n/native/de.json",
      "apps/android/app/src/main/res/values-de/strings.xml",
    ];
    expectAllowed(migration);
    for (const incomplete of [
      migration.slice(1),
      migration.filter((filePath) => filePath !== "apps/android/app/build.gradle.kts"),
      [...migration, "apps/ios/Resources/Localizable.xcstrings"],
      [...migration, mainActivity],
    ]) {
      expectMixed(incomplete);
    }
  });
});
