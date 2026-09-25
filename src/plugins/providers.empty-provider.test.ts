import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  resolveOwningPluginIdsForModelRef,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef,
} from "./providers.js";

describe("provider references without runtime declarations", () => {
  it.each(["manifest", "snapshot"] as const)(
    "requires an alias receiver while preserving CLI and model ownership through %s",
    (source) => {
      const emptyOwner = {
        id: "empty-owner",
        providers: [],
        cliBackends: ["shared-ref"],
        providerAuthAliases: { "shared-ref": "target" },
        modelCatalog: { aliases: { "catalog-ref": { provider: "target" } } },
        modelSupport: { modelPrefixes: ["synthetic-prefix-"] },
        setup: { providers: [{ id: "target" }] },
      };
      const empty = createPluginMetadataSnapshotFixture({ plugins: [emptyOwner] });
      const lookup =
        source === "manifest"
          ? { manifestRegistry: empty.manifestRegistry }
          : { metadataSnapshot: empty };

      expect(
        resolveOwningPluginIdsForProvider({ ...lookup, provider: "shared-ref" }),
      ).toBeUndefined();
      expect(
        resolveOwningPluginIdsForProvider({ ...lookup, provider: "catalog-ref" }),
      ).toBeUndefined();
      expect(resolveOwningPluginIdsForProviderRef({ ...lookup, provider: " SHARED-REF " })).toEqual(
        ["empty-owner"],
      );
      expect(
        resolveOwningPluginIdsForModelRef({
          model: "synthetic-prefix-model",
          manifestRegistry: empty.manifestRegistry,
        }),
      ).toEqual(["empty-owner"]);

      const populated = createPluginMetadataSnapshotFixture({
        plugins: [
          emptyOwner,
          {
            id: "runtime-owner",
            providers: ["TARGET"],
            providerAuthAliases: { "shared-ref": "target" },
            modelCatalog: { aliases: { "catalog-ref": { provider: "target" } } },
          },
        ],
      });
      const nextLookup =
        source === "manifest"
          ? { manifestRegistry: populated.manifestRegistry }
          : { metadataSnapshot: populated };
      for (const provider of [" SHARED-REF ", "catalog-ref"]) {
        expect(resolveOwningPluginIdsForProvider({ ...nextLookup, provider })).toEqual([
          "runtime-owner",
        ]);
        expect(resolveOwningPluginIdsForProviderRef({ ...nextLookup, provider })).toEqual([
          "runtime-owner",
        ]);
      }
    },
  );
});
