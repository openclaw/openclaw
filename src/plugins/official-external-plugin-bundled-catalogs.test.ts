import { expect, it, vi } from "vitest";
import {
  getOfficialExternalPluginCatalogEntry as entryFor,
  getOfficialExternalPluginCatalogEntryForPackage as packageEntry,
  isOfficialExternalPluginId as isOfficial,
  listOfficialExternalChannelCatalogEntries,
  listOfficialExternalPluginCatalogEntries,
  listOfficialExternalProviderCatalogEntries,
  resolveOfficialExternalProviderContractPluginIds as contractPlugins,
  resolveOfficialExternalProviderPluginIds as providerPlugins,
} from "./official-external-plugin-catalog.js";
import type { OfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog.types.js";
import {
  hasOfficialExternalChannelTarget as channelTarget,
  hasOfficialExternalContractTarget as hasContract,
  hasOfficialExternalProviderTarget as providerTarget,
  hasOfficialExternalWebContractEnvTarget as webEnvTarget,
  hasOfficialExternalWebSearchTarget as webTarget,
} from "./official-external-plugin-targets.js";

const embedding = "embeddingProviders";
const fixtures = vi.hoisted(() => {
  // Plugin-lane setup can import the real catalog before this file's JSON mocks.
  vi.resetModules();
  const winner = {
    name: " @fixture/Shared ",
    kind: " plugin ",
    openclaw: {
      plugin: { id: " Shared " },
      channel: { id: "Channel" },
      providers: [{ id: " Model ", aliases: [" Alias "] }],
      contracts: { embeddingProviders: [" Capability "] },
    },
  };
  function targetEntry(id: string, prefix: string): OfficialExternalPluginCatalogEntry {
    return {
      name: `@fixture/${prefix}`,
      openclaw: {
        plugin: { id },
        channel: {
          id: `${prefix}-channel`,
          configuredState: { env: { allOf: [`${prefix}_CHANNEL_KEY`] } },
        },
        providers: [{ id: `${prefix}-model`, envVars: [`${prefix}_MODEL_KEY`] }],
        contracts: {
          embeddingProviders: [`${prefix}-embedding`],
          webFetchProviders: [`${prefix}-web`],
        },
        webSearchProviders: [{ id: `${prefix}-web`, envVars: [`${prefix}_WEB_KEY`] }],
      },
    };
  }
  const rejected = {
    ...targetEntry("SourceFiltered", "rejected"),
    install: { candidates: [{ sourceRef: "unconfigured-source", package: "@fixture/rejected" }] },
  };
  const accepted = {
    name: "@fixture/accepted",
    openclaw: { plugin: { id: "SourceFiltered" } },
    install: { candidates: [{ sourceRef: "public-npm", package: "@fixture/accepted" }] },
  };
  const shadow = targetEntry("Shared", "shadow");
  const pluginShadow = { name: "@fixture/plugin-shadow", openclaw: { plugin: { id: "Shared" } } };
  const otherKind = { ...pluginShadow, name: "@fixture/other-kind", kind: "channel" };
  const lowercase = { name: "@fixture/shared", openclaw: { plugin: { id: "shared" } } };
  const fallback = { id: "FallbackOnly", name: "@fixture/fallback" };
  return {
    winner,
    accepted,
    lowercase,
    channelCatalog: { entries: [rejected, winner, otherKind] },
    providerCatalog: { entries: [shadow, accepted, lowercase] },
    pluginCatalog: { entries: [pluginShadow, fallback] },
  };
});

vi.mock("../../scripts/lib/official-external-channel-catalog.json", () => ({
  default: fixtures.channelCatalog,
}));
vi.mock("../../scripts/lib/official-external-provider-catalog.json", () => ({
  default: fixtures.providerCatalog,
}));
vi.mock("../../scripts/lib/official-external-plugin-catalog.json", () => ({
  default: fixtures.pluginCatalog,
}));

it("rejects unconfigured source references before selecting a duplicate or lookup match", () => {
  expect(entryFor("SourceFiltered")).toBe(fixtures.accepted);
  expect(entryFor("rejected-model")).toBeUndefined();
  expect(packageEntry("@fixture/rejected")).toBeUndefined();
  expect(providerPlugins({ providerIds: new Set(["rejected-model"]) })).toEqual([]);
});

it("keeps exact lookup identities separate from lowercase canonical and provider queries", () => {
  expect(entryFor(" Shared ")).toBe(fixtures.winner);
  expect(entryFor("shared")).toBe(fixtures.lowercase);
  expect(entryFor(" Alias ")).toBe(fixtures.winner);
  expect(entryFor("alias")).toBeUndefined();
  expect(packageEntry(" @fixture/Shared ")).toBe(fixtures.winner);
  expect(packageEntry("@fixture/SHARED")).toBeUndefined();
  expect(isOfficial(" SHARED ")).toBe(true);
  expect(isOfficial("Alias")).toBe(false);
  expect(isOfficial("fallbackonly")).toBe(true);
  expect(entryFor("FallbackOnly")).toBeUndefined();
  expect(providerPlugins({ providerIds: new Set([" ALIAS "]) })).toEqual(["Shared"]);
  const capabilityIds = new Set([" capability "]);
  expect(contractPlugins({ contract: embedding, providerIds: capabilityIds })).toEqual(["Shared"]);
});

it.each([
  ["plugin", listOfficialExternalPluginCatalogEntries],
  ["channel", listOfficialExternalChannelCatalogEntries],
  ["provider", listOfficialExternalProviderCatalogEntries],
] as const)("returns independent %s arrays with shared row identities", (_kind, list) => {
  const first = list();
  expect(first).not.toBe(list());
  expect(first[0]).toBe(fixtures.winner);
  first.length = 0;
  expect(list()[0]).toBe(fixtures.winner);
});

it.each(["shadow", "rejected"])("keeps repair targets from excluded %s rows", (prefix) => {
  const env = (kind: string) => ({ [`${prefix}_${kind}_KEY`]: "key" });
  expect(entryFor(`${prefix}-model`)).toBeUndefined();
  expect([
    providerTarget({ providerIds: [` ${prefix.toUpperCase()}-MODEL `], env: {} }),
    providerTarget({ providerIds: [], env: env("MODEL") }),
    hasContract({ contract: embedding, providerIds: [`${prefix}-embedding`] }),
    channelTarget({ config: {}, env: env("CHANNEL") }),
    webEnvTarget({ env: env("WEB") }),
    webTarget({ providerId: `${prefix}-web`, env: {} }),
  ]).toEqual([true, true, true, true, true, true]);
});
