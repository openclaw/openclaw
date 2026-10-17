import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isOfficialCatalogLookupPluginIdReplacement as isReplacement,
  isThirdPartyNpmInstallRecord as isThirdParty,
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
      expect(
        isTrusted({
          pluginId: "fish-audio-speech",
          packageName,
          record: { ...npmRecord, ...override },
        }),
      ).toBe(false);
    },
  );

  it.each([
    { name: "default official host", overrides: {}, trusted: true },
    { name: "missing authority", overrides: { clawhubUrl: undefined }, trusted: false },
    { name: "custom host", overrides: { clawhubUrl: "https://example.invalid" }, trusted: false },
    { name: "community channel", overrides: { clawhubChannel: "community" }, trusted: false },
    { name: "conflicting resolution", overrides: { resolvedName: "@vendor/acpx" }, trusted: false },
    {
      name: "resolved identity alone",
      overrides: { spec: undefined, clawhubPackage: undefined },
      trusted: false,
    },
  ] satisfies Array<{
    name: string;
    overrides: Partial<PluginInstallRecord>;
    trusted: boolean;
  }>)("requires current ClawHub authority: $name", ({ overrides, trusted }) => {
    expect(
      isTrusted({
        pluginId: "acpx",
        packageName: "@openclaw/acpx",
        record: clawhubInstall("@openclaw/acpx", { resolvedName: "@openclaw/acpx", ...overrides }),
      }),
    ).toBe(trusted);
  });
});

describe("third-party npm install records", () => {
  const pluginId = "third-party-demo";
  const packageName = "@acme/third-party-demo";
  const record: PluginInstallRecord = {
    source: "npm",
    spec: `${packageName}@1.0.0`,
    resolvedName: packageName,
    resolvedSpec: `${packageName}@1.0.0`,
  };

  it("accepts a consistent non-catalog npm install", () => {
    expect(isThirdParty({ pluginId, packageName, record })).toBe(true);
  });

  it("accepts a spec-only consistent record", () => {
    expect(
      isThirdParty({
        pluginId,
        packageName,
        record: { source: "npm", spec: `${packageName}@1.0.0` },
      }),
    ).toBe(true);
  });

  it("accepts a consistent legacy clawhub package field", () => {
    expect(
      isThirdParty({
        pluginId,
        packageName,
        record: { ...record, clawhubPackage: packageName },
      }),
    ).toBe(true);
  });

  it.each([
    { name: "conflicting identity", overrides: { resolvedName: "@vendor/other" } },
    { name: "malformed spec", overrides: { spec: "file:/tmp/plugin.tgz" } },
    { name: "local npm archive", overrides: { artifactKind: "npm-pack" } },
    { name: "source path", overrides: { sourcePath: "/tmp/plugin" } },
    { name: "conflicting clawhub package", overrides: { clawhubPackage: "@vendor/other" } },
    { name: "clawhub source", overrides: { source: "clawhub" } },
    {
      name: "missing identity",
      overrides: { spec: undefined, resolvedName: undefined, resolvedSpec: undefined },
    },
  ] satisfies Array<{ name: string; overrides: Partial<PluginInstallRecord> }>)(
    "rejects $name",
    ({ overrides }) => {
      expect(
        isThirdParty({
          pluginId,
          packageName,
          record: { ...record, ...overrides },
        }),
      ).toBe(false);
    },
  );

  it.each([undefined, "@acme/other"])("rejects candidate package %s", (candidate) => {
    expect(isThirdParty({ pluginId, packageName: candidate, record })).toBe(false);
  });

  it("rejects an official catalog package recorded from npm", () => {
    expect(
      isThirdParty({
        pluginId: "other-plugin",
        packageName: "@openclaw/acpx",
        record: { source: "npm", spec: "@openclaw/acpx@2026.7.2" },
      }),
    ).toBe(false);
  });

  it("rejects an official catalog plugin id with an unendorsed npm namesake", () => {
    expect(
      isThirdParty({
        pluginId: "agentmail",
        packageName: "@agentmail/agentmail",
        record: { source: "npm", spec: "@agentmail/agentmail@0.2.1" },
      }),
    ).toBe(false);
  });
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
    expect(
      isReplacement({
        expectedPluginId: "qqbot",
        expectedReplacementPluginId: "openclaw-qqbot",
      }),
    ).toBe(true);
    expect(
      isReplacement({
        expectedPluginId: "fish-audio",
        expectedReplacementPluginId: "fish-audio-speech",
      }),
    ).toBe(false);
  });

  it("fails closed when a legacy npm package identity is mixed with another package", () => {
    expect(
      resolveNpm({
        pluginId: "openclaw-qqbot",
        record: npmInstall("@openclaw/qqbot", "1.9.0", { resolvedName: "@vendor/qqbot" }),
      }),
    ).toBeUndefined();
  });

  it("rejects local source path provenance before migrating a legacy npm package", () => {
    expect(
      resolveNpm({
        pluginId: "qqbot",
        record: npmInstall("@openclaw/qqbot", "1.9.0", { sourcePath: "/tmp/openclaw-qqbot" }),
      }),
    ).toBeUndefined();
  });

  it("drops a catalog lookup duplicate only for unanimous canonical npm identity", () => {
    const duplicate = (replacementRecord: PluginInstallRecord) =>
      isDuplicate({
        pluginId: "qqbot",
        replacementPluginId: "openclaw-qqbot",
        replacementRecord,
      });
    expect(duplicate(npmInstall("@tencent-connect/openclaw-qqbot", "2.0.1"))).toBe(true);
    expect(
      duplicate(
        npmInstall("@vendor/openclaw-qqbot", "1.0.0", {
          resolvedName: "@tencent-connect/openclaw-qqbot",
        }),
      ),
    ).toBe(false);
    expect(
      duplicate(
        npmInstall("@tencent-connect/openclaw-qqbot", "2.0.1", { artifactKind: "npm-pack" }),
      ),
    ).toBe(false);
  });

  it("never accepts the legacy Fish Audio id through ClawHub", () => {
    expect(
      resolveClawHub({
        pluginId: "fish-audio",
        record: clawhubInstall("@openclaw/fish-audio-speech"),
      }),
    ).toBeUndefined();
  });
});
