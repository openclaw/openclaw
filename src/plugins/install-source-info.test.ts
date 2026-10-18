import { expect, it } from "vitest";
import { describePluginInstallSource } from "./install-source-info.js";
import { resolveManagedPluginInstallRequest } from "./install-source-plan.js";

it.each([
  [undefined, false],
  ["latest", false],
  ["1.2.3", true],
])("classifies ClawHub selector %s with exactVersion=%s", (version, exactVersion) => {
  const spec = `clawhub:demo${version ? `@${version}` : ""}`;
  expect(describePluginInstallSource({ clawhubSpec: spec })).toEqual({
    clawhub: {
      spec,
      packageName: "demo",
      ...(version ? { version } : {}),
      exactVersion,
    },
    warnings: exactVersion ? [] : ["clawhub-spec-floating"],
  });
});

it("accepts ClawHub-only integrity metadata", () => {
  const expectedIntegrity = "ab".repeat(32);
  const source = describePluginInstallSource({
    clawhubSpec: "clawhub:@vendor/demo@1.2.3",
    expectedIntegrity,
    defaultChoice: "clawhub",
  });
  expect(source.clawhub).toMatchObject({ packageName: "@vendor/demo", exactVersion: true });
  expect(source.npm).toBeUndefined();
  expect(source.warnings).toEqual([]);
});

const npmSource = (selector: string, exactVersion: boolean) => ({
  spec: `@vendor/demo@${selector}`,
  packageName: "@vendor/demo",
  selector,
  selectorKind: exactVersion ? ("exact-version" as const) : ("tag" as const),
  exactVersion,
});
const exactNpm = npmSource("1.2.3", true);
const floatingNpm = npmSource("beta", false);
const clawhub = {
  spec: "clawhub:@vendor/demo@1.2.3",
  packageName: "@vendor/demo",
  version: "1.2.3",
  exactVersion: true,
};
const pinnedNpm = {
  ...exactNpm,
  expectedIntegrity: "sha512-demo",
  pinState: "exact-with-integrity",
} as const;
const unverifiedNpm = { ...exactNpm, pinState: "exact-without-integrity" } as const;
const local = { path: "extensions/demo" };
const invalidNpm = "github:vendor/demo";
const npmIntegrity = "sha512-demo";
const clawhubIntegrity = `sha256:${"ab".repeat(32)}`;
const missingIntegrity = ["npm-spec-missing-integrity"] as const;
const floating = ["npm-spec-floating"] as const;
type SourceCase = [
  install: Parameters<typeof describePluginInstallSource>[0],
  expected: ReturnType<typeof describePluginInstallSource>,
  options?: Parameters<typeof describePluginInstallSource>[1],
];

it.each([
  [exactNpm, " sha512-demo ", "exact-with-integrity", [], "npm"],
  [exactNpm, undefined, "exact-without-integrity", missingIntegrity],
  [floatingNpm, "sha512-demo", "floating-with-integrity", floating],
  [floatingNpm, undefined, "floating-without-integrity", [...floating, ...missingIntegrity]],
] as const)(
  "describes npm pin %j with %s",
  (npm, expectedIntegrity, pinState, warnings, defaultChoice?: "npm") => {
    const install = { npmSpec: npm.spec, expectedIntegrity, defaultChoice };
    expect(describePluginInstallSource(install)).toEqual({
      ...(defaultChoice ? { defaultChoice } : {}),
      npm: {
        ...npm,
        pinState,
        ...(expectedIntegrity ? { expectedIntegrity: expectedIntegrity.trim() } : {}),
      },
      warnings,
    });
  },
);

it.each<SourceCase>([
  [
    {
      clawhubSpec: clawhub.spec,
      npmSpec: exactNpm.spec,
      expectedIntegrity: npmIntegrity,
      defaultChoice: "clawhub",
    },
    { defaultChoice: "clawhub", clawhub, npm: pinnedNpm, warnings: [] },
  ],
  [
    { npmSpec: "@vendor/other@1.2.3", expectedIntegrity: npmIntegrity },
    {
      npm: {
        ...pinnedNpm,
        spec: "@vendor/other@1.2.3",
        packageName: "@vendor/other",
        expectedPackageName: "@vendor/demo",
      },
      warnings: ["npm-spec-package-name-mismatch"],
    },
    { expectedPackageName: "@vendor/demo" },
  ],
  [
    { npmSpec: exactNpm.spec, defaultChoice: "registry" } as never,
    {
      npm: unverifiedNpm,
      warnings: ["invalid-default-choice", "npm-spec-missing-integrity"],
    },
  ],
  [
    { npmSpec: invalidNpm, localPath: local.path },
    { local, warnings: ["invalid-npm-spec"] },
  ],
  [
    { localPath: local.path, defaultChoice: "local" },
    { defaultChoice: "local", local, warnings: [] },
  ],
  [
    { localPath: local.path, defaultChoice: "npm" },
    { defaultChoice: "npm", local, warnings: ["default-choice-missing-source"] },
  ],
  [
    { npmSpec: invalidNpm, defaultChoice: "npm" },
    { defaultChoice: "npm", warnings: ["invalid-npm-spec", "default-choice-missing-source"] },
  ],
  [{ expectedIntegrity: clawhubIntegrity }, { warnings: ["npm-integrity-without-source"] }],
  [
    { localPath: local.path, expectedIntegrity: npmIntegrity },
    { local, warnings: ["npm-integrity-without-source"] },
  ],
  [
    { clawhubSpec: clawhub.spec, expectedIntegrity: "not-a-hash" },
    { clawhub, warnings: ["npm-integrity-without-source"] },
  ],
  [
    { clawhubSpec: clawhub.spec, npmSpec: invalidNpm, expectedIntegrity: clawhubIntegrity },
    { clawhub, warnings: ["invalid-npm-spec", "npm-integrity-without-source"] },
  ],
])("describes %j", (install, expected, options) => {
  expect(describePluginInstallSource(install, options)).toEqual(expected);
});
const hex = "ab".repeat(32);
const integrity = `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
const catalog = [
  {
    name: "@example/fixture",
    openclaw: {
      plugin: { id: "fixture" },
      install: { clawhubSpec: "clawhub:community/fixture@1.2.3", expectedIntegrity: integrity },
    },
  },
];
const resolveCatalog = (constraints: { expectedIntegrity?: string; expectedPluginId?: string }) =>
  resolveManagedPluginInstallRequest(
    { source: "clawhub", packageName: "community/fixture", ...constraints },
    catalog,
  );

it("normalizes the installer's ClawHub digest before comparing catalog provenance", () => {
  expect(resolveCatalog({ expectedIntegrity: hex })).toMatchObject({
    source: "clawhub",
    spec: "clawhub:community/fixture@1.2.3",
    expectedPluginId: "fixture",
    expectedIntegrity: integrity,
  });
});

it.each([
  { expectedPluginId: "another-plugin" },
  { expectedIntegrity: `sha256:${"cd".repeat(32)}` },
])("rejects caller constraints that conflict with catalog provenance", (constraint) => {
  expect(() => resolveCatalog(constraint)).toThrow("differs from the official catalog");
});
