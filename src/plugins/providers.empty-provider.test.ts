import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  resolveOwningPluginIdsForModelRef,
  resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef,
} from "./providers.js";

type Plugins = NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]>["plugins"];

describe.each(["manifest", "snapshot"] as const)("provider ownership through %s", (source) => {
  function lookup(plugins: Plugins) {
    const snapshot = createPluginMetadataSnapshotFixture({ plugins });
    const scope =
      source === "manifest"
        ? { manifestRegistry: snapshot.manifestRegistry }
        : { metadataSnapshot: snapshot };
    return {
      provider: (provider: string) => resolveOwningPluginIdsForProvider({ ...scope, provider }),
      ref: (provider: string) => resolveOwningPluginIdsForProviderRef({ ...scope, provider }),
      model: (model: string) =>
        resolveOwningPluginIdsForModelRef({
          model,
          manifestRegistry: snapshot.manifestRegistry,
        }),
    };
  }

  it("requires an alias receiver while preserving CLI and model ownership", () => {
    const owner = {
      id: "empty-owner",
      providers: [],
      cliBackends: ["shared-ref"],
      providerAuthAliases: { "shared-ref": "target" },
      modelCatalog: { aliases: { "catalog-ref": { provider: "target" } } },
      modelSupport: { modelPrefixes: ["synthetic-prefix-"] },
      setup: { providers: [{ id: "target" }] },
    };
    const empty = lookup([owner]);
    expect([empty.provider("shared-ref"), empty.provider("catalog-ref")]).toEqual([
      undefined,
      undefined,
    ]);
    expect(empty.ref(" SHARED-REF ")).toEqual(["empty-owner"]);
    expect(empty.model("synthetic-prefix-model")).toEqual(["empty-owner"]);

    const populated = lookup([
      owner,
      {
        id: "runtime-owner",
        providers: ["TARGET"],
        providerAuthAliases: owner.providerAuthAliases,
        modelCatalog: owner.modelCatalog,
      },
    ]);
    for (const ref of [" SHARED-REF ", "catalog-ref"]) {
      expect([populated.provider(ref), populated.ref(ref)]).toEqual([
        ["runtime-owner"],
        ["runtime-owner"],
      ]);
    }
  });

  it("publishes sorted, deduplicated owners with provider precedence", () => {
    const index = lookup([
      { id: "z-owner", providers: ["TARGET", "target"], cliBackends: ["cli-ref", "CLI-REF"] },
      { id: "a-owner", providers: ["target"], cliBackends: ["cli-ref"] },
      { id: "cli-only", providers: [], cliBackends: ["target"] },
    ]);
    const providerOwners = index.provider("target");
    expect(providerOwners).toEqual(["a-owner", "z-owner"]);
    for (const ref of [" TARGET ", "cli-ref"]) {
      const owners = index.ref(ref);
      expect(owners).toEqual(["a-owner", "z-owner"]);
      expect(Object.isFrozen(owners)).toBe(true);
      expect(index.ref(ref)).toBe(owners);
    }
    expect(index.ref("target")).toBe(providerOwners);
  });

  it("shares immutable owner results and replaces them with the generation", () => {
    const generation = (id: string) =>
      lookup([
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
      ]);
    const first = generation("first-owner");
    for (const ref of ["target", "auth-ref", "catalog-ref", "cli-ref"]) {
      const owners = first.ref(ref);
      expect(owners).toEqual([ref === "cli-ref" ? "cli-owner" : "first-owner"]);
      expect(first.ref(` ${ref.toUpperCase()} `)).toBe(owners);
      expect(Object.isFrozen(owners)).toBe(true);
      expect(first.model(`${ref}/synthetic-model`)).toBe(owners);
    }
    for (const ref of ["orphan", "orphan-catalog", "missing"]) {
      expect(first.ref(ref)).toBeUndefined();
    }
    expect(generation("replacement-owner").ref("target")).toEqual(["replacement-owner"]);
    expect(first.ref("target")).toEqual(["first-owner"]);
    expect(lookup([]).ref("target")).toBeUndefined();
  });
});
