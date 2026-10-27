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

  it("shares sorted immutable owners with provider precedence and replaces the generation", () => {
    const generation = (id: string) =>
      lookup([
        { id: "z-owner", providers: ["target"], cliBackends: ["cli-ref", "CLI-REF"] },
        {
          id,
          providers: ["TARGET", "target"],
          providerAuthAliases: { " AUTH-REF ": " target ", orphan: "absent" },
          setup: { providers: [{ id: "absent" }] },
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
    expect(first.provider("cli-ref")).toBeUndefined();
    for (const ref of ["orphan", "orphan-catalog", "missing"]) {
      expect(first.ref(ref)).toBeUndefined();
    }
    expect(generation("replacement-owner").ref("target")).toEqual(["replacement-owner", "z-owner"]);
    expect(first.ref("target")).toEqual(["first-owner", "z-owner"]);
    expect(lookup([]).ref("target")).toBeUndefined();
  });
});
