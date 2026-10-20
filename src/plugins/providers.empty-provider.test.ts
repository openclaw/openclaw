import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  resolveOwningPluginIdsForModelRef,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef,
} from "./providers.js";

function lookupFor(
  snapshot: ReturnType<typeof createPluginMetadataSnapshotFixture>,
  source: "manifest" | "snapshot",
) {
  return source === "manifest"
    ? { manifestRegistry: snapshot.manifestRegistry }
    : { metadataSnapshot: snapshot };
}

describe.each(["manifest", "snapshot"] as const)("provider ownership through %s", (source) => {
  it("requires an alias receiver while preserving CLI and model ownership", () => {
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
    const lookup = lookupFor(empty, source);

    for (const provider of ["shared-ref", "catalog-ref"]) {
      expect(resolveOwningPluginIdsForProvider({ ...lookup, provider })).toBeUndefined();
    }
    expect(resolveOwningPluginIdsForProviderRef({ ...lookup, provider: " SHARED-REF " })).toEqual([
      "empty-owner",
    ]);
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
    const nextLookup = lookupFor(populated, source);
    for (const provider of [" SHARED-REF ", "catalog-ref"]) {
      expect(resolveOwningPluginIdsForProvider({ ...nextLookup, provider })).toEqual([
        "runtime-owner",
      ]);
      expect(resolveOwningPluginIdsForProviderRef({ ...nextLookup, provider })).toEqual([
        "runtime-owner",
      ]);
    }
  });
  it("publishes sorted, deduplicated owners with provider precedence", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "z-owner",
          providers: ["TARGET", "target"],
          cliBackends: ["cli-ref", "CLI-REF"],
        },
        { id: "a-owner", providers: ["target"], cliBackends: ["cli-ref"] },
        { id: "cli-only", providers: [], cliBackends: ["target"] },
      ],
    });
    const lookup = lookupFor(snapshot, source);
    const providerOwners = resolveOwningPluginIdsForProvider({ ...lookup, provider: "target" });
    expect(providerOwners).toEqual(["a-owner", "z-owner"]);
    for (const provider of [" TARGET ", "cli-ref"]) {
      const owners = resolveOwningPluginIdsForProviderRef({ ...lookup, provider });
      expect(owners).toEqual(["a-owner", "z-owner"]);
      expect(Object.isFrozen(owners)).toBe(true);
      expect(resolveOwningPluginIdsForProviderRef({ ...lookup, provider })).toBe(owners);
    }
    expect(resolveOwningPluginIdsForProviderRef({ ...lookup, provider: "target" })).toBe(
      providerOwners,
    );
  });

  it("shares immutable owner results and replaces them with the generation", () => {
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
        ...lookupFor(snapshot, source),
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
  });
});
