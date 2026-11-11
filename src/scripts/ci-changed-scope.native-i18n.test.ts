import { describe, expect, it } from "vitest";

const { assertNativeGeneratedArtifactsIsolated, shouldRunNativeI18n, shouldStrictNativeI18n } =
  await import("../../scripts/ci-changed-scope.mjs");

const nativeSource = "apps/.i18n/native-source.json";
const androidLookup =
  "apps/android/app/src/main/java/ai/openclaw/app/i18n/NativeStringResources.kt";
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
  it.each<[string[] | null, boolean]>([
    [["scripts/native-app-i18n.ts"], false],
    [["scripts/native-i18n-inventory.ts"], false],
    [["apps/android/app/src/play/java/ai/openclaw/app/PlayBilling.kt"], false],
    [["apps/android/app/src/thirdParty/res/values/accessibility_strings.xml"], false],
    [["apps/ios/Sources/RootTabs.swift", nativeSource], false],
    [null, true],
    ...canonicalArtifacts.map((file): [string[], boolean] => [[file], true]),
    [["apps/android/app/src/thirdParty/res/values-sv/accessibility_strings.xml"], true],
  ])("routes %j with strict parity %s", (paths, strict) => {
    expect(shouldRunNativeI18n(paths)).toBe(true);
    expect(shouldStrictNativeI18n(paths)).toBe(strict);
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
    expectAllowed([...generatedPaths, "apps/ios/Sources/RootTabs.swift"], "main");
    expectAllowed([...generatedCompanionPaths, nativeSource]);
    expectMixed([...generatedPaths, ...generatedCompanionPaths, nativeSource]);
  });

  it("rejects mixed source and generated artifacts shaped like the completed v2 migration", () => {
    const migration = [
      ".gitattributes",
      ...sharedOwners,
      "scripts/apple-app-i18n.ts",
      "test/scripts/apple-app-i18n.test.ts",
      nativeSource,
      ...canonicalArtifacts,
    ];

    expectMixed(migration);
  });

  it("rejects mixed artifacts shaped like the completed Android projection retirement", () => {
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
    expectMixed(migration);
  });
});
