import { describe, expect, it } from "vitest";
import { describePluginInstallSource } from "./install-source-info.js";
import { resolveManagedPluginInstallRequest } from "./install-source-plan.js";

describe("describePluginInstallSource", () => {
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

  const exactNpm = {
    spec: "@vendor/demo@1.2.3",
    packageName: "@vendor/demo",
    selector: "1.2.3",
    selectorKind: "exact-version",
    exactVersion: true,
  } as const;
  const floatingNpm = {
    spec: "@vendor/demo@beta",
    packageName: "@vendor/demo",
    selector: "beta",
    selectorKind: "tag",
    exactVersion: false,
  } as const;
  const clawhub = {
    spec: "clawhub:@vendor/demo@1.2.3",
    packageName: "@vendor/demo",
    version: "1.2.3",
    exactVersion: true,
  };
  type SourceCase = {
    name: string;
    install: Parameters<typeof describePluginInstallSource>[0];
    options?: Parameters<typeof describePluginInstallSource>[1];
    expected: ReturnType<typeof describePluginInstallSource>;
  };

  it.each<SourceCase>([
    {
      name: "exact npm with trimmed integrity",
      install: { npmSpec: exactNpm.spec, expectedIntegrity: " sha512-demo ", defaultChoice: "npm" },
      expected: {
        defaultChoice: "npm",
        npm: { ...exactNpm, expectedIntegrity: "sha512-demo", pinState: "exact-with-integrity" },
        warnings: [],
      },
    },
    {
      name: "exact npm without integrity",
      install: { npmSpec: exactNpm.spec },
      expected: {
        npm: { ...exactNpm, pinState: "exact-without-integrity" },
        warnings: ["npm-spec-missing-integrity"],
      },
    },
    {
      name: "floating npm with integrity",
      install: { npmSpec: floatingNpm.spec, expectedIntegrity: "sha512-demo" },
      expected: {
        npm: {
          ...floatingNpm,
          expectedIntegrity: "sha512-demo",
          pinState: "floating-with-integrity",
        },
        warnings: ["npm-spec-floating"],
      },
    },
    {
      name: "floating npm without integrity",
      install: { npmSpec: floatingNpm.spec },
      expected: {
        npm: { ...floatingNpm, pinState: "floating-without-integrity" },
        warnings: ["npm-spec-floating", "npm-spec-missing-integrity"],
      },
    },
    {
      name: "npm integrity ownership with both sources declared",
      install: {
        clawhubSpec: clawhub.spec,
        npmSpec: exactNpm.spec,
        expectedIntegrity: "sha512-demo",
        defaultChoice: "clawhub",
      },
      expected: {
        defaultChoice: "clawhub",
        clawhub,
        npm: { ...exactNpm, expectedIntegrity: "sha512-demo", pinState: "exact-with-integrity" },
        warnings: [],
      },
    },
    {
      name: "package identity mismatch",
      install: { npmSpec: "@vendor/other@1.2.3", expectedIntegrity: "sha512-demo" },
      options: { expectedPackageName: "@vendor/demo" },
      expected: {
        npm: {
          ...exactNpm,
          spec: "@vendor/other@1.2.3",
          packageName: "@vendor/other",
          expectedPackageName: "@vendor/demo",
          expectedIntegrity: "sha512-demo",
          pinState: "exact-with-integrity",
        },
        warnings: ["npm-spec-package-name-mismatch"],
      },
    },
    {
      name: "invalid default choice",
      install: { npmSpec: exactNpm.spec, defaultChoice: "registry" } as never,
      expected: {
        npm: { ...exactNpm, pinState: "exact-without-integrity" },
        warnings: ["invalid-default-choice", "npm-spec-missing-integrity"],
      },
    },
    {
      name: "invalid npm with a local source",
      install: { npmSpec: "github:vendor/demo", localPath: "extensions/demo" },
      expected: { local: { path: "extensions/demo" }, warnings: ["invalid-npm-spec"] },
    },
    {
      name: "local default",
      install: { localPath: "extensions/demo", defaultChoice: "local" },
      expected: { defaultChoice: "local", local: { path: "extensions/demo" }, warnings: [] },
    },
    {
      name: "default pointing to missing npm",
      install: { localPath: "extensions/demo", defaultChoice: "npm" },
      expected: {
        defaultChoice: "npm",
        local: { path: "extensions/demo" },
        warnings: ["default-choice-missing-source"],
      },
    },
    {
      name: "default pointing to invalid npm",
      install: { npmSpec: "github:vendor/demo", defaultChoice: "npm" },
      expected: {
        defaultChoice: "npm",
        warnings: ["invalid-npm-spec", "default-choice-missing-source"],
      },
    },
    {
      name: "integrity without any source",
      install: { expectedIntegrity: `sha256:${"ab".repeat(32)}` },
      expected: { warnings: ["npm-integrity-without-source"] },
    },
    {
      name: "integrity with only a local source",
      install: { localPath: "extensions/demo", expectedIntegrity: "sha512-demo" },
      expected: { local: { path: "extensions/demo" }, warnings: ["npm-integrity-without-source"] },
    },
    {
      name: "invalid ClawHub integrity",
      install: { clawhubSpec: clawhub.spec, expectedIntegrity: "not-a-hash" },
      expected: { clawhub, warnings: ["npm-integrity-without-source"] },
    },
    {
      name: "ClawHub cannot conceal invalid npm integrity ownership",
      install: {
        clawhubSpec: clawhub.spec,
        npmSpec: "github:vendor/demo",
        expectedIntegrity: `sha256:${"ab".repeat(32)}`,
      },
      expected: { clawhub, warnings: ["invalid-npm-spec", "npm-integrity-without-source"] },
    },
  ])("describes $name", ({ install, options, expected }) => {
    expect(describePluginInstallSource(install, options)).toEqual(expected);
  });
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

describe("managed install source constraints", () => {
  it("normalizes the installer's ClawHub digest before comparing catalog provenance", () => {
    const expectedIntegrity = hex;
    expect(
      resolveManagedPluginInstallRequest(
        {
          source: "clawhub",
          packageName: "community/fixture",
          expectedIntegrity,
        },
        catalog,
      ),
    ).toMatchObject({
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
    expect(() =>
      resolveManagedPluginInstallRequest(
        {
          source: "clawhub",
          packageName: "community/fixture",
          ...constraint,
        },
        catalog,
      ),
    ).toThrow("differs from the official catalog");
  });
});
