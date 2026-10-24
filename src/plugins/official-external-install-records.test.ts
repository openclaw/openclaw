import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isCommunityClawHubInstallRecord,
  isOfficialCatalogLookupPluginIdReplacement as isReplacement,
  isThirdPartyNpmInstallRecord,
  isTrustedOfficialCatalogLookupDuplicate as isDuplicate,
  isTrustedOfficialPluginInstallRecord as isTrusted,
  resolveTrustedSourceLinkedOfficialClawHubInstall as resolveClawHub,
  resolveTrustedSourceLinkedOfficialNpmInstall as resolveNpm,
} from "./official-external-install-records.js";

const QQBOT_EXPECTED_INTEGRITY =
  "sha512-yngu/2cPeZjJfIfHWCXWB2/6KlDHrb9vpOUjKLdQxePLSp6wCn3CFOALcBIVq/9o6jlYz9WTU9idW6nfX1xpFA==";

function npmInstall(
  packageName: string,
  version: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "npm",
    spec: `${packageName}@${version}`,
    resolvedName: packageName,
    resolvedSpec: `${packageName}@${version}`,
    ...overrides,
  };
}

function clawhubInstall(
  packageName: string,
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return {
    source: "clawhub",
    spec: `clawhub:${packageName}`,
    clawhubPackage: packageName,
    clawhubUrl: "https://clawhub.ai",
    clawhubChannel: "official",
    ...overrides,
  };
}

describe("official plugin install trust", () => {
  const packageName = "@openclaw/fish-audio-speech";
  const npmRecord = npmInstall(packageName, "2026.7.2");
  const trusts = (record: PluginInstallRecord) =>
    isTrusted({ pluginId: "fish-audio-speech", packageName, record });

  it("binds the declared legacy id to the actual official package", () => {
    expect(isTrusted({ pluginId: "fish-audio", packageName, record: npmRecord })).toBe(true);
  });

  it.each([
    { pluginId: "fish-audio-speech", packageName: undefined },
    { pluginId: "unrelated-plugin", packageName },
    { pluginId: "fish-audio-speech", packageName: "@vendor/fish-audio-speech" },
  ])("rejects an unbound catalog identity $pluginId / $packageName", (identity) => {
    expect(isTrusted({ ...identity, record: npmRecord })).toBe(false);
  });

  it.each([
    { spec: "@vendor/fish-audio-speech" },
    { resolvedName: "@vendor/fish-audio-speech" },
    { resolvedSpec: "@vendor/fish-audio-speech@1.0.0" },
    { clawhubPackage: "@vendor/fish-audio-speech" },
    { spec: "file:/tmp/official.tgz" },
    { resolvedName: `${packageName}@2026.7.2` },
    { spec: undefined, resolvedName: undefined, resolvedSpec: undefined },
    { artifactKind: "npm-pack" },
    { sourcePath: "/tmp/official" },
    { source: "path" },
  ] satisfies Partial<PluginInstallRecord>[])(
    "rejects unsupported npm provenance %j",
    (override) => {
      expect(trusts({ ...npmRecord, ...override })).toBe(false);
    },
  );

  it.each<[Partial<PluginInstallRecord>, boolean]>([
    [{}, true],
    [{ clawhubUrl: undefined }, false],
    [{ clawhubUrl: "https://example.invalid" }, false],
    [{ clawhubChannel: "community" }, false],
    [{ resolvedName: "@vendor/acpx" }, false],
    [{ spec: undefined, clawhubPackage: undefined }, false],
  ])("requires current ClawHub authority %j: %s", (overrides, trusted) => {
    expect(
      isTrusted({
        pluginId: "acpx",
        packageName: "@openclaw/acpx",
        record: clawhubInstall("@openclaw/acpx", { resolvedName: "@openclaw/acpx", ...overrides }),
      }),
    ).toBe(trusted);
  });
});

describe("community ClawHub install records", () => {
  const packageName = "@acme/community-demo";
  const record: PluginInstallRecord = {
    source: "clawhub",
    spec: `clawhub:${packageName}@1.0.0`,
    clawhubPackage: packageName,
    clawhubUrl: "https://clawhub.ai/",
    clawhubChannel: "community",
  };

  const isCommunity = (
    candidate: string | undefined,
    install: PluginInstallRecord,
    pluginId = "community-demo",
  ) => isCommunityClawHubInstallRecord(pluginId, candidate, install);

  it("accepts a consistent community listing", () => {
    expect(isCommunity(packageName, record)).toBe(true);
  });

  it.each([
    { name: "official channel", overrides: { clawhubChannel: "official" } },
    { name: "missing channel", overrides: { clawhubChannel: undefined } },
    { name: "custom host", overrides: { clawhubUrl: "https://example.invalid" } },
    { name: "conflicting identity", overrides: { resolvedName: "@vendor/other" } },
    { name: "npm source", overrides: { source: "npm" } },
  ] satisfies Array<{ name: string; overrides: Partial<PluginInstallRecord> }>)(
    "rejects $name",
    ({ overrides }) => {
      expect(isCommunity(packageName, { ...record, ...overrides })).toBe(false);
    },
  );

  it.each([undefined, "@acme/other"])("rejects candidate package %s", (candidate) => {
    expect(isCommunity(candidate, record)).toBe(false);
  });

  it("rejects an official catalog package recorded as community", () => {
    expect(
      isCommunity("@openclaw/acpx", {
        ...record,
        spec: undefined,
        clawhubPackage: "@openclaw/acpx",
      }),
    ).toBe(false);
  });

  it("rejects an official plugin id claimed by a community package", () => {
    expect(isCommunity(packageName, record, "acpx")).toBe(false);
  });
});

describe("third-party npm install identity", () => {
  it.each([
    { resolvedName: "@vendor/other" },
    { resolvedSpec: "@vendor/other@1.0.0" },
    { clawhubPackage: "@vendor/other" },
    { spec: "file:/tmp/plugin.tgz" },
    { artifactKind: "npm-pack" },
    { sourcePath: "/tmp/plugin" },
    { source: "clawhub" },
  ] satisfies Partial<PluginInstallRecord>[])(
    "rejects conflicting or local evidence %j",
    (override) => {
      expect(
        isThirdPartyNpmInstallRecord(
          "demo",
          "@vendor/demo",
          npmInstall("@vendor/demo", "1.0.0", override),
        ),
      ).toBe(false);
    },
  );
});

describe("trusted official npm install records", () => {
  it("preserves canonical official updates for resolved-spec-only evidence", () => {
    const record: PluginInstallRecord = { source: "npm", resolvedSpec: "@openclaw/acpx@2026.7.2" };
    expect(resolveNpm({ pluginId: "acpx", record })?.npmSpec).toBe("@openclaw/acpx");
  });

  it("returns a replacement only for a catalog-declared legacy id", () => {
    const record = npmInstall("@openclaw/fish-audio-speech", "2026.7.2-beta.7");

    expect(resolveNpm({ pluginId: "fish-audio", record })).toEqual({
      npmSpec: "@openclaw/fish-audio-speech",
      pluginId: "fish-audio-speech",
      replacementPluginId: "fish-audio-speech",
    });
    expect(resolveNpm({ pluginId: "unrelated-plugin", record })).toBeUndefined();
  });

  it("rewrites a catalog-declared legacy npm package to the current official spec", () => {
    const record = npmInstall("@openclaw/qqbot", "1.9.0");
    const expected = {
      expectedIntegrity: QQBOT_EXPECTED_INTEGRITY,
      npmSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
      pluginId: "openclaw-qqbot",
      replaceNpmPackage: true,
    };

    expect(resolveNpm({ pluginId: "openclaw-qqbot", record })).toEqual(expected);
    expect(resolveNpm({ pluginId: "qqbot", record })).toEqual({
      ...expected,
      replacementPluginId: "openclaw-qqbot",
    });
    const replacement = (expectedPluginId: string, expectedReplacementPluginId: string) =>
      isReplacement({ expectedPluginId, expectedReplacementPluginId });
    expect(replacement("qqbot", "openclaw-qqbot")).toBe(true);
    expect(replacement("fish-audio", "fish-audio-speech")).toBe(false);
  });

  it.each([
    ["openclaw-qqbot", { resolvedName: "@vendor/qqbot" }],
    ["qqbot", { sourcePath: "/tmp/openclaw-qqbot" }],
  ] as const)("rejects %s migration with invalid provenance %j", (pluginId, override) => {
    expect(
      resolveNpm({
        pluginId,
        record: npmInstall("@openclaw/qqbot", "1.9.0", override),
      }),
    ).toBeUndefined();
  });

  it.each<[string, Partial<PluginInstallRecord>, boolean]>([
    ["@tencent-connect/openclaw-qqbot", {}, true],
    ["@vendor/openclaw-qqbot", { resolvedName: "@tencent-connect/openclaw-qqbot" }, false],
    ["@tencent-connect/openclaw-qqbot", { artifactKind: "npm-pack" }, false],
  ])(
    "drops a catalog duplicate only for unanimous npm identity %s %j",
    (name, override, expected) => {
      expect(
        isDuplicate({
          pluginId: "qqbot",
          replacementPluginId: "openclaw-qqbot",
          replacementRecord: npmInstall(name, "2.0.1", override),
        }),
      ).toBe(expected);
    },
  );

  it("never accepts the legacy Fish Audio id through ClawHub", () => {
    const record = clawhubInstall("@openclaw/fish-audio-speech");
    expect(resolveClawHub({ pluginId: "fish-audio", record })).toBeUndefined();
  });
});
