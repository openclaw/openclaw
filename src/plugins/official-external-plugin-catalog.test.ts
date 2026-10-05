import { describe, expect, it } from "vitest";
import {
  getOfficialExternalChannelSecretContract,
  getOfficialExternalPluginCatalogEntry,
  getOfficialExternalPluginCatalogEntryForPackage,
  isExternallyDistributedPlugin,
  isOfficialExternalPluginId,
  isOfficialExternalPluginCatalogFeed,
  listOfficialExternalChannelEnvVars,
  resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLegacyIds,
  resolveOfficialExternalPluginLegacyNpmPackageNames,
} from "./official-external-plugin-catalog.js";
import {
  installableEntry,
  hostedCatalogFeed,
} from "./official-external-plugin-catalog.test-support.js";

describe("official external plugin catalog", () => {
  it.each([
    { pluginId: "google-meet", packageName: "@openclaw/google-meet", external: true },
    {
      pluginId: "google-meet",
      packageName: "@openclaw/google-meet",
      packageBuild: { bundledDist: true },
      external: false,
    },
    { pluginId: "google-meet", packageName: "@example/google-meet", external: false },
    { pluginId: "other-plugin", packageName: "@openclaw/google-meet", external: false },
    {
      pluginId: "source-external",
      packageName: "@example/source-external",
      packageBuild: { bundledDist: false },
      external: true,
    },
  ])(
    "classifies distribution ownership for $pluginId from $packageName",
    ({ external, ...plugin }) => {
      expect(isExternallyDistributedPlugin(plugin)).toBe(external);
    },
  );

  it("keeps Fish Audio's legacy id migration-only across npm and ClawHub routes", () => {
    const entry = getOfficialExternalPluginCatalogEntryForPackage("@openclaw/fish-audio-speech");
    expect(entry).toBeDefined();
    expect(resolveOfficialExternalPluginId(entry!)).toBe("fish-audio-speech");
    expect(resolveOfficialExternalPluginLegacyIds(entry!)).toEqual(["fish-audio"]);
    expect(resolveOfficialExternalPluginInstall(entry!)).toEqual({
      clawhubSpec: "clawhub:@openclaw/fish-audio-speech",
      npmSpec: "@openclaw/fish-audio-speech",
      defaultChoice: "npm",
      minHostVersion: ">=2026.7.2",
    });
    expect(getOfficialExternalPluginCatalogEntry("fish-audio-speech")).toBe(entry);
    expect(getOfficialExternalPluginCatalogEntry("fish-audio")).toBeUndefined();
    expect(isOfficialExternalPluginId("fish-audio-speech")).toBe(true);
    expect(isOfficialExternalPluginId("fish-audio")).toBe(false);
  });

  it("does not allow malformed feed wrappers to count as feed documents", () => {
    const feed = hostedCatalogFeed({ sequence: 1, pluginName: "@acme/plugin" });
    feed.generatedAt = " 2026-06-22 00:00:10Z ";
    expect(isOfficialExternalPluginCatalogFeed({ ...feed, schemaVersion: 2 })).toBe(true);
    for (const invalid of [
      { id: " " },
      { schemaVersion: 3 },
      { generatedAt: "not-a-date" },
      { generatedAt: "2026-02-30T00:00:00.000Z" },
      { sequence: Number.POSITIVE_INFINITY },
    ]) {
      expect(isOfficialExternalPluginCatalogFeed({ ...feed, ...invalid })).toBe(false);
    }
  });

  it("prefers feed install candidates before legacy install metadata", () => {
    expect(
      resolveOfficialExternalPluginInstall({
        ...installableEntry("@openclaw/candidate-package", {
          integrity: "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
        }),
        name: "@legacy/plain-package",
        openclaw: {
          plugin: { id: "candidate-package" },
          install: {
            npmSpec: "@legacy/plain-package",
            minHostVersion: ">=2026.6.1",
            expectedIntegrity: "sha256:manifest",
            allowInvalidConfigRecovery: true,
          },
        },
      }),
    ).toEqual({
      clawhubSpec: "clawhub:@openclaw/candidate-package@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
      minHostVersion: ">=2026.6.1",
      allowInvalidConfigRecovery: true,
    });
    for (const [integrity, expected] of [
      [undefined, { npmSpec: "@acme/private@4.5.6", defaultChoice: "npm" }],
      [
        "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9",
        { npmSpec: "@acme/private@4.5.6", defaultChoice: "npm" },
      ],
      [
        "sha512-abc=",
        { npmSpec: "@acme/private@4.5.6", defaultChoice: "npm", expectedIntegrity: "sha512-abc=" },
      ],
    ] as const) {
      expect(
        resolveOfficialExternalPluginInstall(
          installableEntry("@acme/private", { sourceRef: "acme-npm", version: "4.5.6", integrity }),
          { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
        ),
      ).toEqual(expected);
    }
    expect(
      resolveOfficialExternalPluginInstall(
        {
          name: "git-only-package",
          kind: "plugin",
          install: {
            candidates: [{ sourceRef: "acme-git", package: "git@example.com:acme/plugin.git" }],
          },
        },
        { catalogConfig: { sources: { "acme-git": { type: "git" } } } },
      ),
    ).toBeNull();
    expect(
      resolveOfficialExternalPluginInstall({ id: "metadata-only", title: "Metadata only" }),
    ).toBeNull();
  });

  it("resolves channel aliases and legacy packages to their published owner", () => {
    const entry = getOfficialExternalPluginCatalogEntry("qqbot");
    if (!entry) {
      throw new Error("Expected catalog entry for qqbot");
    }
    expect(getOfficialExternalPluginCatalogEntry("openclaw-qqbot")).toBe(entry);
    expect(resolveOfficialExternalPluginId(entry)).toBe("openclaw-qqbot");
    expect(resolveOfficialExternalPluginLegacyNpmPackageNames(entry)).toEqual(["@openclaw/qqbot"]);
    expect(resolveOfficialExternalPluginInstall(entry)).toEqual({
      npmSpec: "@tencent-connect/openclaw-qqbot@2.0.3",
      defaultChoice: "npm",
      expectedIntegrity:
        "sha512-yngu/2cPeZjJfIfHWCXWB2/6KlDHrb9vpOUjKLdQxePLSp6wCn3CFOALcBIVq/9o6jlYz9WTU9idW6nfX1xpFA==",
    });
    expect(getOfficialExternalChannelSecretContract("qqbot")).toEqual({
      channelId: "qqbot",
      fields: [{ field: "clientSecret", activationField: "appId", activationEnv: "QQBOT_APP_ID" }],
    });
  });

  it("projects channel environment variables from generated configured-state metadata", () => {
    const envVarsByChannel = new Map(
      listOfficialExternalChannelEnvVars().map((entry) => [entry.channelId, entry.envVars]),
    );

    expect(envVarsByChannel.get("clickclack")).toEqual(["CLICKCLACK_BOT_TOKEN"]);
    expect(envVarsByChannel.get("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
  });

  it("maps capability provider ids to plugin owners", () => {
    expect(
      resolveOfficialExternalProviderContractPluginIds({
        contract: "speechProviders",
        providerIds: new Set(["gradium", "inworld", "xiaomi"]),
      }),
    ).toEqual(["gradium", "inworld", "xiaomi"]);
  });

  it("maps env-only web-fetch credentials to external plugin owners", () => {
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { FIRECRAWL_API_KEY: "firecrawl-key" },
      }),
    ).toEqual(["firecrawl"]);
    expect(
      resolveOfficialExternalWebProviderContractPluginIdsForEnv({
        contract: "webFetchProviders",
        env: { EXA_API_KEY: "exa-key" },
      }),
    ).toEqual([]);
  });

  it("maps configured provider ids and aliases even without an auth choice", () => {
    expect(
      resolveOfficialExternalProviderPluginIds({
        providerIds: new Set(["groq", "modelstudio"]),
      }),
    ).toEqual(["groq", "qwen"]);
  });

  it("maps env-only provider credentials to external installs", () => {
    expect(
      resolveOfficialExternalProviderPluginIdsForEnv({
        GROQ_API_KEY: "groq-key",
        MODELSTUDIO_API_KEY: "qwen-key",
      }),
    ).toEqual(["groq", "qwen"]);
    expect(resolveOfficialExternalProviderPluginIdsForEnv({ GROQ_API_KEY: " " })).toEqual([]);
  });
});
