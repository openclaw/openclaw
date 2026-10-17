import { describe, expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  isCommunityClawHubInstallRecord,
  isOfficialCatalogLookupPluginIdReplacement,
  isTrustedOfficialCatalogLookupDuplicate,
  isTrustedOfficialPluginInstallRecord,
  resolveTrustedSourceLinkedOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmInstall,
} from "./official-external-install-records.js";

const QQBOT_EXPECTED_INTEGRITY =
  "sha512-yngu/2cPeZjJfIfHWCXWB2/6KlDHrb9vpOUjKLdQxePLSp6wCn3CFOALcBIVq/9o6jlYz9WTU9idW6nfX1xpFA==";

describe("official plugin install trust", () => {
  const packageName = "@openclaw/fish-audio-speech";
  const npmRecord: PluginInstallRecord = {
    source: "npm",
    spec: `${packageName}@2026.7.2`,
    resolvedName: packageName,
    resolvedSpec: `${packageName}@2026.7.2`,
  };

  it.each(["fish-audio"])(
    "binds canonical and declared legacy id %s to the actual official package",
    (pluginId) => {
      expect(
        isTrustedOfficialPluginInstallRecord({ pluginId, packageName, record: npmRecord }),
      ).toBe(true);
    },
  );

  it.each([
    { pluginId: "fish-audio-speech", packageName: undefined },
    { pluginId: "unrelated-plugin", packageName },
    { pluginId: "fish-audio-speech", packageName: "@vendor/fish-audio-speech" },
  ])("rejects an unbound catalog identity $pluginId / $packageName", (identity) => {
    expect(isTrustedOfficialPluginInstallRecord({ ...identity, record: npmRecord })).toBe(false);
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
        isTrustedOfficialPluginInstallRecord({
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
      isTrustedOfficialPluginInstallRecord({
        pluginId: "acpx",
        packageName: "@openclaw/acpx",
        record: {
          source: "clawhub",
          spec: "clawhub:@openclaw/acpx",
          clawhubPackage: "@openclaw/acpx",
          clawhubUrl: "https://clawhub.ai",
          clawhubChannel: "official",
          resolvedName: "@openclaw/acpx",
          ...overrides,
        },
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

  it("accepts a consistent community listing", () => {
    expect(isCommunityClawHubInstallRecord({ packageName, record })).toBe(true);
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
      expect(
        isCommunityClawHubInstallRecord({ packageName, record: { ...record, ...overrides } }),
      ).toBe(false);
    },
  );

  it.each([undefined, "@acme/other"])("rejects candidate package %s", (candidate) => {
    expect(isCommunityClawHubInstallRecord({ packageName: candidate, record })).toBe(false);
  });

  it("rejects an official catalog package recorded as community", () => {
    expect(
      isCommunityClawHubInstallRecord({
        packageName: "@openclaw/acpx",
        record: { ...record, spec: undefined, clawhubPackage: "@openclaw/acpx" },
      }),
    ).toBe(false);
  });
});

describe("trusted official npm install records", () => {
  it.each([
    {
      name: "resolved-spec-only evidence",
      record: {
        source: "npm" as const,
        resolvedSpec: "@openclaw/acpx@2026.7.2",
      },
    },
  ])("preserves canonical official updates for $name", ({ record }) => {
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({ pluginId: "acpx", record })?.npmSpec,
    ).toBe("@openclaw/acpx");
  });

  it("returns a replacement only for a catalog-declared legacy id", () => {
    const record = {
      source: "npm" as const,
      spec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
      resolvedName: "@openclaw/fish-audio-speech",
      resolvedSpec: "@openclaw/fish-audio-speech@2026.7.2-beta.7",
    };

    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "fish-audio",
        record,
      }),
    ).toEqual({
      npmSpec: "@openclaw/fish-audio-speech",
      pluginId: "fish-audio-speech",
      replacementPluginId: "fish-audio-speech",
    });
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "unrelated-plugin",
        record,
      }),
    ).toBeUndefined();
  });

  it("rewrites a catalog-declared legacy npm package to the current official spec", () => {
    const record = {
      source: "npm" as const,
      spec: "@openclaw/qqbot@1.9.0",
      resolvedName: "@openclaw/qqbot",
      resolvedSpec: "@openclaw/qqbot@1.9.0",
    };

    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "openclaw-qqbot",
        record,
      }),
    ).toEqual({
      expectedIntegrity: QQBOT_EXPECTED_INTEGRITY,
      npmSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
      pluginId: "openclaw-qqbot",
      replaceNpmPackage: true,
    });
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "qqbot",
        record,
      }),
    ).toEqual({
      expectedIntegrity: QQBOT_EXPECTED_INTEGRITY,
      npmSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
      pluginId: "openclaw-qqbot",
      replacementPluginId: "openclaw-qqbot",
      replaceNpmPackage: true,
    });
    expect(
      isOfficialCatalogLookupPluginIdReplacement({
        expectedPluginId: "qqbot",
        expectedReplacementPluginId: "openclaw-qqbot",
      }),
    ).toBe(true);
    expect(
      isOfficialCatalogLookupPluginIdReplacement({
        expectedPluginId: "fish-audio",
        expectedReplacementPluginId: "fish-audio-speech",
      }),
    ).toBe(false);
  });

  it("fails closed when a legacy npm package identity is mixed with another package", () => {
    expect(
      resolveTrustedSourceLinkedOfficialNpmInstall({
        pluginId: "openclaw-qqbot",
        record: {
          source: "npm",
          spec: "@openclaw/qqbot@1.9.0",
          resolvedName: "@vendor/qqbot",
          resolvedSpec: "@openclaw/qqbot@1.9.0",
        },
      }),
    ).toBeUndefined();
  });

  it.each([{ name: "local source path", provenance: { sourcePath: "/tmp/openclaw-qqbot" } }])(
    "rejects $name provenance before migrating a legacy npm package",
    ({ provenance }) => {
      expect(
        resolveTrustedSourceLinkedOfficialNpmInstall({
          pluginId: "qqbot",
          record: {
            source: "npm",
            spec: "@openclaw/qqbot@1.9.0",
            resolvedName: "@openclaw/qqbot",
            resolvedSpec: "@openclaw/qqbot@1.9.0",
            ...provenance,
          },
        }),
      ).toBeUndefined();
    },
  );

  it("drops a catalog lookup duplicate only for unanimous canonical npm identity", () => {
    expect(
      isTrustedOfficialCatalogLookupDuplicate({
        pluginId: "qqbot",
        replacementPluginId: "openclaw-qqbot",
        replacementRecord: {
          source: "npm",
          spec: "@tencent-connect/openclaw-qqbot@2.0.1",
          resolvedName: "@tencent-connect/openclaw-qqbot",
          resolvedSpec: "@tencent-connect/openclaw-qqbot@2.0.1",
        },
      }),
    ).toBe(true);
    expect(
      isTrustedOfficialCatalogLookupDuplicate({
        pluginId: "qqbot",
        replacementPluginId: "openclaw-qqbot",
        replacementRecord: {
          source: "npm",
          spec: "@vendor/openclaw-qqbot@1.0.0",
          resolvedName: "@tencent-connect/openclaw-qqbot",
          resolvedSpec: "@vendor/openclaw-qqbot@1.0.0",
        },
      }),
    ).toBe(false);
    expect(
      isTrustedOfficialCatalogLookupDuplicate({
        pluginId: "qqbot",
        replacementPluginId: "openclaw-qqbot",
        replacementRecord: {
          source: "npm",
          spec: "@tencent-connect/openclaw-qqbot@2.0.1",
          resolvedName: "@tencent-connect/openclaw-qqbot",
          resolvedSpec: "@tencent-connect/openclaw-qqbot@2.0.1",
          artifactKind: "npm-pack",
        },
      }),
    ).toBe(false);
  });

  it("never accepts the legacy Fish Audio id through ClawHub", () => {
    expect(
      resolveTrustedSourceLinkedOfficialClawHubInstall({
        pluginId: "fish-audio",
        record: {
          source: "clawhub",
          spec: "clawhub:@openclaw/fish-audio-speech",
          clawhubPackage: "@openclaw/fish-audio-speech",
          clawhubChannel: "official",
          clawhubUrl: "https://clawhub.ai",
        },
      }),
    ).toBeUndefined();
  });
});
