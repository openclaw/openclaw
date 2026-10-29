import { expect, it } from "vitest";
import {
  getOfficialExternalChannelSecretContract as channelSecrets,
  getOfficialExternalPluginCatalogEntry as findEntry,
  getOfficialExternalPluginCatalogEntryForPackage as findPackage,
  isOfficialExternalPluginId as isOfficialId,
  isOfficialExternalPluginCatalogFeed as isFeed,
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

it("routes Abliteration and either credential variable to its official package", () => {
  const entry = findPackage("@openclaw/abliteration-provider");
  expect(findEntry("abliteration")).toBe(entry);
  expect(resolveInstall(entry!)?.npmSpec).toBe("@openclaw/abliteration-provider");
  for (const name of ["ABLITERATION_API_KEY", "ABLIT_KEY"]) {
    expect(providerEnvOwners({ [name]: "synthetic-key" })).toEqual(["abliteration"]);
  }
});

it("keeps Fish Audio's legacy id migration-only across npm and ClawHub routes", () => {
  const entry = findPackage("@openclaw/fish-audio-speech");
  expect(pluginId(entry!)).toBe("fish-audio-speech");
  expect(resolveOfficialExternalPluginLegacyIds(entry!)).toEqual(["fish-audio"]);
  expect(resolveInstall(entry!)?.npmSpec).toBe("@openclaw/fish-audio-speech");
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
  expect(findEntry("openclaw-qqbot")).toBe(entry);
  expect(resolveInstall(entry)?.defaultChoice).toBe("npm");
  expect(channelSecrets("qqbot")).toEqual({
    channelId: "qqbot",
    fields: [{ field: "clientSecret", activationField: "appId", activationEnv: "QQBOT_APP_ID" }],
  });
});

it.each<[NodeJS.ProcessEnv, string[]]>([
  [{ FIRECRAWL_API_KEY: "firecrawl-key" }, ["firecrawl"]],
  [{ EXA_API_KEY: "exa-key" }, []],
])("maps web-fetch credentials %j to %j", (env, expected) => {
  expect(webEnvOwners({ env })).toEqual(expected);
});

it("maps env-only provider credentials to external installs", () => {
  const env = { GROQ_API_KEY: "groq-key", MODELSTUDIO_API_KEY: "qwen-key" };
  expect(providerEnvOwners(env)).toEqual(["groq", "qwen"]);
  expect(providerEnvOwners({ GROQ_API_KEY: " " })).toEqual([]);
});
