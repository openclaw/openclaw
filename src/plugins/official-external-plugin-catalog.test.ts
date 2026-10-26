import { describe, expect, it, vi } from "vitest";
import * as catalogSource from "./official-external-plugin-catalog-source.js";
import {
  getOfficialExternalChannelSecretContract as channelSecrets,
  getOfficialExternalPluginCatalogEntry as findEntry,
  getOfficialExternalPluginCatalogEntryForPackage as findPackage,
  isOfficialExternalPluginId as isOfficialId,
  isOfficialExternalPluginCatalogFeed as isFeed,
  listOfficialExternalPluginCatalogEntries as listEntries,
  resolveOfficialExternalProviderContractPluginIds as capabilityOwners,
  resolveOfficialExternalProviderPluginIds as providerOwners,
  resolveOfficialExternalProviderPluginIdsForEnv as providerEnvOwners,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv as webEnvOwners,
  resolveOfficialExternalPluginId as pluginId,
  resolveOfficialExternalPluginInstall as resolveInstall,
  resolveOfficialExternalPluginLegacyIds,
} from "./official-external-plugin-catalog.js";
import {
  installableEntry,
  hostedCatalogFeed,
} from "./official-external-plugin-catalog.test-support.js";

const sha256 = "sha256:b355dda04403becaab8bbab069fd1e7b0578262e7459e598cc5b19615b5bdab9";

describe("official external plugin catalog", () => {
  it("reuses admitted bundled identities across inventory reads without sharing the list array", () => {
    const entries = listEntries();
    const entry = findEntry("fish-audio-speech");
    expect(entry).toBeDefined();
    const candidates = vi.spyOn(catalogSource, "getFeedEntryInstallCandidateRecords");
    const manifests = vi.spyOn(catalogSource, "getOfficialExternalPluginCatalogManifest");
    try {
      for (let read = 0; read < 3; read++) {
        const listed = listEntries();
        expect(listed).not.toBe(entries);
        expect(listed).toEqual(entries);
        listed.length = 0;
        expect(findEntry(" fish-audio-speech ")).toBe(entry);
        expect(findPackage(" @openclaw/fish-audio-speech ")).toBe(entry);
        expect(isOfficialId(" FISH-AUDIO-SPEECH ")).toBe(true);
        expect(findEntry("FISH-AUDIO-SPEECH")).toBeUndefined();
        expect(findPackage("@openclaw/FISH-AUDIO-SPEECH")).toBeUndefined();
        expect(findEntry("synthetic-community-plugin")).toBeUndefined();
        expect(findPackage("@synthetic/community-plugin")).toBeUndefined();
        expect(isOfficialId("synthetic-community-plugin")).toBe(false);
      }
      expect(candidates.mock.calls.length).toBe(0);
      expect(manifests.mock.calls.length).toBe(0);
    } finally {
      candidates.mockRestore();
      manifests.mockRestore();
    }
  });

  it("routes Abliteration and either credential variable to its official package", () => {
    const entry = findPackage("@openclaw/abliteration-provider");
    expect(entry).toBeDefined();
    expect(findEntry("abliteration")).toBe(entry);
    expect(resolveInstall(entry!)).toEqual({
      clawhubSpec: "clawhub:@openclaw/abliteration-provider",
      npmSpec: "@openclaw/abliteration-provider",
      defaultChoice: "npm",
      minHostVersion: ">=2026.10.6",
    });
    expect(providerOwners({ providerIds: new Set(["abliteration"]) })).toEqual(["abliteration"]);
    for (const name of ["ABLITERATION_API_KEY", "ABLIT_KEY"]) {
      expect(providerEnvOwners({ [name]: "synthetic-key" })).toEqual(["abliteration"]);
    }
  });

  it("keeps Fish Audio's legacy id migration-only across npm and ClawHub routes", () => {
    const entry = findPackage("@openclaw/fish-audio-speech");
    expect(entry).toBeDefined();
    expect(pluginId(entry!)).toBe("fish-audio-speech");
    expect(resolveOfficialExternalPluginLegacyIds(entry!)).toEqual(["fish-audio"]);
    expect(resolveInstall(entry!)).toEqual({
      clawhubSpec: "clawhub:@openclaw/fish-audio-speech",
      npmSpec: "@openclaw/fish-audio-speech",
      defaultChoice: "npm",
      minHostVersion: ">=2026.7.2",
    });
    expect(findEntry("fish-audio-speech")).toBe(entry);
    expect(findEntry("fish-audio")).toBeUndefined();
    expect(["fish-audio-speech", "fish-audio"].map(isOfficialId)).toEqual([true, false]);
  });

  it("does not allow malformed feed wrappers to count as feed documents", () => {
    const feed = hostedCatalogFeed({ sequence: 1, pluginName: "@acme/plugin" });
    feed.generatedAt = " 2026-06-22 00:00:10Z ";
    expect(isFeed({ ...feed, schemaVersion: 2 })).toBe(true);
    for (const invalid of [
      { id: " " },
      { schemaVersion: 3 },
      { generatedAt: "not-a-date" },
      { generatedAt: "2026-02-30T00:00:00.000Z" },
      { sequence: Number.POSITIVE_INFINITY },
    ]) {
      expect(isFeed({ ...feed, ...invalid })).toBe(false);
    }
  });

  it("prefers feed install candidates before legacy install metadata", () => {
    const entry = {
      ...installableEntry("@openclaw/candidate-package", { integrity: sha256 }),
      name: "@legacy/plain-package",
      openclaw: {
        install: {
          npmSpec: "@legacy/plain-package",
          minHostVersion: ">=2026.6.1",
          expectedIntegrity: "sha256:manifest",
          allowInvalidConfigRecovery: true,
        },
      },
    };
    expect(resolveInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@openclaw/candidate-package@1.2.3",
      defaultChoice: "clawhub",
      expectedIntegrity: "sha256-s1XdoEQDvsqri7qwaf0eewV4Ji50WeWYzFsZYVtb2rk=",
      minHostVersion: ">=2026.6.1",
      allowInvalidConfigRecovery: true,
    });
    for (const [integrity, expectedIntegrity] of [
      [undefined, undefined],
      [sha256, undefined],
      ["sha512-abc=", "sha512-abc="],
    ] as const) {
      expect(
        resolveInstall(
          installableEntry("@acme/private", { sourceRef: "acme-npm", version: "4.5.6", integrity }),
          { catalogConfig: { sources: { "acme-npm": { type: "npm" } } } },
        ),
      ).toEqual({
        npmSpec: "@acme/private@4.5.6",
        defaultChoice: "npm",
        ...(expectedIntegrity ? { expectedIntegrity } : {}),
      });
    }
    const gitEntry = {
      name: "git-only-package",
      kind: "plugin",
      install: {
        candidates: [{ sourceRef: "acme-git", package: "git@example.com:acme/plugin.git" }],
      },
    };
    expect(
      resolveInstall(gitEntry, { catalogConfig: { sources: { "acme-git": { type: "git" } } } }),
    ).toBeNull();
    expect(resolveInstall({ id: "metadata-only", title: "Metadata only" })).toBeNull();
  });

  it("resolves channel aliases, defaults, and secret contracts", () => {
    const entry = findEntry("qqbot")!;
    expect(entry).toBeDefined();
    expect(findEntry("openclaw-qqbot")).toBe(entry);
    expect(resolveInstall(entry)?.defaultChoice).toBe("npm");
    expect(channelSecrets("qqbot")).toEqual({
      channelId: "qqbot",
      fields: [{ field: "clientSecret", activationField: "appId", activationEnv: "QQBOT_APP_ID" }],
    });
  });

  it("maps capability provider ids to plugin owners", () => {
    const providerIds = new Set(["gradium", "inworld", "xiaomi"]);
    expect(capabilityOwners({ contract: "speechProviders", providerIds })).toEqual([
      "gradium",
      "inworld",
      "xiaomi",
    ]);
  });

  it.each<[NodeJS.ProcessEnv, string[]]>([
    [{ FIRECRAWL_API_KEY: "firecrawl-key" }, ["firecrawl"]],
    [{ EXA_API_KEY: "exa-key" }, []],
  ])("maps web-fetch credentials %j to %j", (env, expected) => {
    expect(webEnvOwners({ env })).toEqual(expected);
  });

  it("maps configured provider ids and aliases even without an auth choice", () => {
    const providerIds = new Set(["groq", "modelstudio"]);
    expect(providerOwners({ providerIds })).toEqual(["groq", "qwen"]);
  });

  it("maps env-only provider credentials to external installs", () => {
    const env = { GROQ_API_KEY: "groq-key", MODELSTUDIO_API_KEY: "qwen-key" };
    expect(providerEnvOwners(env)).toEqual(["groq", "qwen"]);
    expect(providerEnvOwners({ GROQ_API_KEY: " " })).toEqual([]);
  });
});
