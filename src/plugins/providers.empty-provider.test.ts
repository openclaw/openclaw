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

describe("provider ownership registry lifetime", () => {
  it.each(["manifest", "snapshot"] as const)(
    "shares immutable owner results and replaces them with the %s generation",
    (source) => {
      const makeSnapshot = (id: string) =>
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id,
              providers: ["TARGET", "target"],
              providerAuthAliases: { " AUTH-REF ": " target ", orphan: "absent" },
              modelCatalog: {
                aliases: {
                  "catalog-ref": { provider: "target" },
                  "orphan-catalog": { provider: "absent" },
                },
              },
            },
            { id: "cli-owner", providers: [], setup: { cliBackends: ["auth-ref", "cli-ref"] } },
          ],
        });
      const first = makeSnapshot("first-owner");
      const lookup = (snapshot: typeof first, provider: string) =>
        resolveOwningPluginIdsForProviderRef({
          provider,
          ...(source === "manifest"
            ? { manifestRegistry: snapshot.manifestRegistry }
            : { metadataSnapshot: snapshot }),
        });
      for (const ref of ["target", "auth-ref", "catalog-ref", "cli-ref"]) {
        const owners = lookup(first, ref);
        expect(owners).toEqual([ref === "cli-ref" ? "cli-owner" : "first-owner"]);
        expect(lookup(first, ` ${ref.toUpperCase()} `)).toBe(owners);
        expect(Object.isFrozen(owners)).toBe(true);
        expect(
          resolveOwningPluginIdsForModelRef({
            model: `${ref}/synthetic-model`,
            manifestRegistry: first.manifestRegistry,
          }),
        ).toBe(owners);
      }
      for (const ref of ["orphan", "orphan-catalog", "missing"]) {
        expect(lookup(first, ref)).toBeUndefined();
      }
      const replacement = makeSnapshot("replacement-owner");
      expect(lookup(replacement, "target")).toEqual(["replacement-owner"]);
      expect(lookup(first, "target")).toEqual(["first-owner"]);
      const empty = createPluginMetadataSnapshotFixture({ plugins: [] });
      expect(lookup(empty, "target")).toBeUndefined();
    },
  );
});
