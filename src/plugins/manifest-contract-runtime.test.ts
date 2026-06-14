/** Tests manifest contract runtime resolution across bundled and installed plugin metadata. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";

const loadPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
}));

import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";

describe("resolveManifestContractRuntimePluginResolution", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
  });

  it("resolves contract plugins from the shared metadata snapshot", () => {
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "bundled-search",
            origin: "bundled",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "external-search",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "bundled-search",
          origin: "bundled",
          contracts: { webSearchProviders: ["search"] },
        },
        {
          id: "external-search",
          origin: "global",
          contracts: { webSearchProviders: ["search"] },
        },
      ],
    });

    expect(
      resolveManifestContractRuntimePluginResolution({
        cfg: {},
        contract: "webSearchProviders",
        value: "search",
      }),
    ).toEqual({
      pluginIds: ["bundled-search", "external-search"],
      bundledCompatPluginIds: ["bundled-search"],
    });
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      preferPersisted: false,
    });
  });

  it("skips unreadable contract plugin metadata while resolving healthy plugins", () => {
    const poisonedContracts = Object.defineProperty({}, "contracts", {
      get() {
        throw new Error("contract metadata exploded");
      },
    }) as PluginManifestRecord;
    const poisonedOrigin = Object.defineProperties(
      {},
      {
        contracts: {
          value: { webSearchProviders: ["search"] },
        },
        origin: {
          get() {
            throw new Error("contract origin exploded");
          },
        },
      },
    ) as PluginManifestRecord;
    const poisonedId = Object.defineProperties(
      {},
      {
        contracts: {
          value: { webSearchProviders: ["search"] },
        },
        origin: {
          value: "global",
        },
        id: {
          get() {
            throw new Error("contract id exploded");
          },
        },
      },
    ) as PluginManifestRecord;
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "bundled-search",
            origin: "bundled",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "external-search",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        poisonedContracts,
        poisonedOrigin,
        poisonedId,
        {
          id: "bundled-search",
          origin: "bundled",
          contracts: { webSearchProviders: ["search"] },
        },
        {
          id: "external-search",
          origin: "global",
          contracts: { webSearchProviders: ["search"] },
        },
      ],
    });

    expect(
      resolveManifestContractRuntimePluginResolution({
        cfg: {},
        contract: "webSearchProviders",
        value: "search",
      }),
    ).toEqual({
      pluginIds: ["bundled-search", "external-search"],
      bundledCompatPluginIds: ["bundled-search"],
    });
  });
});
