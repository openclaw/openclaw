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

  it("shares sorted immutable owners with provider precedence and replaces the generation", () => {
    const generation = (id: string) =>
      lookup([
        { id: "z-owner", providers: ["target"], cliBackends: ["cli-ref", "CLI-REF"] },
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
        {
          id: "cli-owner",
          providers: [],
          setup: { cliBackends: ["target", "auth-ref", "cli-ref"] },
        },
      ]);
    const first = generation("first-owner");
    for (const ref of ["target", "auth-ref", "catalog-ref", "cli-ref"]) {
      const owners = first.ref(ref);
      expect(owners).toEqual(
        ref === "cli-ref"
          ? ["cli-owner", "z-owner"]
          : ref === "target"
            ? ["first-owner", "z-owner"]
            : ["first-owner"],
      );
      expect(first.ref(` ${ref.toUpperCase()} `)).toBe(owners);
      expect(Object.isFrozen(owners)).toBe(true);
      expect(first.model(`${ref}/synthetic-model`)).toBe(owners);
    }
    expect(first.ref("target")).toBe(first.provider("target"));
    for (const ref of ["orphan", "orphan-catalog", "missing"]) {
      expect(first.ref(ref)).toBeUndefined();
    }
    expect(generation("replacement-owner").ref("target")).toEqual(["replacement-owner", "z-owner"]);
    expect(first.ref("target")).toEqual(["first-owner", "z-owner"]);
    expect(lookup([]).ref("target")).toBeUndefined();
  });
});
