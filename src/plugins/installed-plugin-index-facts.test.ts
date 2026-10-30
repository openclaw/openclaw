import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginDeclaredSurface } from "../../test/helpers/plugin-declared-surface.js";
import * as installRecordMap from "../config/plugin-install-record-map.js";
import * as safeRegex from "../security/safe-regex.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex as recordsFrom } from "./installed-plugin-index-install-records.js";
import { createInstalledPluginIndexScopeLookup as scopeLookup } from "./installed-plugin-index-scope-lookup.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { finalizePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

function createSnapshot(provider = "shared") {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: ["alpha", "beta"].map((id) => ({ id, origin: "global" as const })),
  });
  snapshot.index.installRecords = {
    alpha: { source: "npm", spec: " alpha@1 ", clawhubTrustReasons: [" reviewed "] },
  };
  for (const plugin of snapshot.index.plugins) {
    plugin.startup.agentHarnesses = ["fixture-runtime"];
    plugin.contributions = {
      channels: ["fixture-channel"],
      channelConfigs: [],
      providers: [provider, provider],
      modelCatalogProviders: [],
      modelSupportPrefixes: ["fixture/"],
      modelSupportPatterns: ["^fixture-model$"],
      autoEnableProviderIds: [],
      commandAliases: [],
      contracts: { speechProviders: [provider] },
    };
  }
  return snapshot;
}

function ownerIds(lookup: ReturnType<typeof scopeLookup>, id: string) {
  const ids = new Set<string>();
  lookup.addProviderContributionOwners(ids, [id]);
  return [...ids];
}

afterEach(() => vi.restoreAllMocks());

it("indexes canonical transcript sources and retained legacy installed-index contracts", () => {
  const snapshot = createSnapshot();
  const plugin = snapshot.index.plugins[0];
  assert(plugin?.contributions);
  plugin.contributions.contracts = {
    transcriptSourceProviders: ["fixture-transcript-source"],
    meetingNotesSourceProviders: ["fixture-legacy-source"],
  };
  const lookup = scopeLookup(snapshot.index);
  expect(ownerIds(lookup, "fixture-transcript-source")).toEqual(["alpha"]);
  expect(ownerIds(lookup, "fixture-legacy-source")).toEqual(["alpha"]);
});

it("prepares immutable ownership and install records once while preserving caller copies", () => {
  withPluginCache(createPluginCache(), () => {
    const snapshot = createSnapshot();
    const acceptedSurface = createPluginDeclaredSurface({ channels: ["fixture-channel"] });
    assert(snapshot.index.installRecords.alpha);
    snapshot.index.installRecords.alpha.acceptedSurface = acceptedSurface;
    finalizePluginMetadataSnapshot(snapshot);
    const compile = vi.spyOn(safeRegex, "compileSafeRegex");
    const parse = vi.spyOn(installRecordMap, "parsePluginInstallRecordMap");
    const first = scopeLookup(snapshot.index);
    const records = recordsFrom(snapshot.index);
    assert(records.alpha?.acceptedSurface);
    records.alpha.spec = "caller-owned";
    records.alpha.clawhubTrustReasons?.push("caller-owned");
    records.alpha.acceptedSurface.channels.push("caller-owned");
    delete records.alpha;
    first.addProviderContributionOwners = () => {};
    for (let call = 0; call < 5; call++) {
      const lookup = scopeLookup(snapshot.index);
      expect(ownerIds(lookup, " SHARED ")).toEqual(["alpha", "beta"]);
      expect(lookup.canResolveDirectProviderIds(["shared"], new Set())).toBe(false);
      expect(lookup.canResolveDirectProviderIds(["alpha"], new Set())).toBe(true);
      expect(lookup.hasInstalledPluginIds([" ALPHA ", "beta"])).toBe(true);
      expect(lookup.hasInstalledPluginIds(["shared"])).toBe(false);
      expect(lookup.hasShorthandModelOwners(["fixture-model"])).toBe(true);
      expect(lookup.hasShorthandModelOwners(["fixture/anything"])).toBe(true);
      expect(lookup.hasAgentHarnessOwners(["fixture-runtime"])).toBe(true);
      expect(lookup.hasChannelContributionOwners(["fixture-channel"])).toBe(true);
      expect(lookup.hasDirectChannelOwners(["fixture-channel"])).toBe(false);
      expect(recordsFrom(snapshot.index)).toEqual({
        alpha: {
          source: "npm",
          spec: "alpha@1",
          clawhubTrustReasons: ["reviewed"],
          acceptedSurface,
        },
      });
      expect(Object.getPrototypeOf(recordsFrom(snapshot.index))).toBeNull();
    }
    expect.soft(compile).toHaveBeenCalledTimes(2);
    expect.soft(parse).toHaveBeenCalledTimes(1);
    expect(isInstalledPluginEnabled(snapshot.index, "missing")).toBe(false);
  });
});

it("rereads mutable nested inputs even under a frozen shell", () => {
  withPluginCache(createPluginCache(), () => {
    const snapshot = createSnapshot();
    Object.freeze(snapshot.index);
    const owners = (id: string) => ownerIds(scopeLookup(snapshot.index), id);
    expect(owners("shared")).toEqual(["alpha", "beta"]);
    expect(recordsFrom(snapshot.index).alpha?.spec).toBe("alpha@1");
    for (const plugin of snapshot.index.plugins) {
      plugin.contributions!.providers = ["replacement"];
      plugin.contributions!.contracts = {};
    }
    assert(snapshot.index.installRecords.alpha);
    snapshot.index.installRecords.alpha.spec = "alpha@2";
    expect(owners("shared")).toEqual([]);
    expect(owners("replacement")).toEqual(["alpha", "beta"]);
    expect(recordsFrom(snapshot.index).alpha?.spec).toBe("alpha@2");
  });
});

it("keeps operation caches independent and retained lookup callbacks on their original inventory", () => {
  const snapshot = finalizePluginMetadataSnapshot(createSnapshot());
  const cache = createPluginCache();
  const read = () => {
    recordsFrom(snapshot.index);
    return scopeLookup(snapshot.index);
  };
  const parse = vi.spyOn(installRecordMap, "parsePluginInstallRecordMap");
  const retained = withPluginCache(cache, read);
  withPluginCache(createPluginCache(), read);
  withPluginCache(cache, read);
  expect(parse).toHaveBeenCalledTimes(2);
  const replacement = finalizePluginMetadataSnapshot(createSnapshot("replacement"));
  const current = withPluginCache(cache, () => scopeLookup(replacement.index));
  expect(ownerIds(current, "shared")).toEqual([]);
  expect(ownerIds(current, "replacement")).toEqual(["alpha", "beta"]);
  expect(ownerIds(retained, "shared")).toEqual(["alpha", "beta"]);
  expect(ownerIds(retained, "replacement")).toEqual([]);
});
