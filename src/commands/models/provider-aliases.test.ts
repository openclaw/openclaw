import { describe, expect, it } from "vitest";
import { canonicalizeModelCatalogProviderAlias } from "./provider-aliases.js";

const basePlugin = {
  channels: [],
  cliBackends: [],
  diagnostics: [],
  hooks: [],
  manifestPath: "/tmp/openclaw.plugin.json",
  providers: [],
  rootDir: "/tmp/plugin",
  skills: [],
  source: "test",
};

describe("canonicalizeModelCatalogProviderAlias", () => {
  it("skips unreadable manifest alias metadata while preserving healthy aliases", () => {
    const unreadableModelCatalog = {
      ...basePlugin,
      id: "unreadable-model-catalog",
      origin: "global",
      get modelCatalog() {
        throw new Error("model alias metadata exploded");
      },
    };
    const unreadableAliasMap = {
      ...basePlugin,
      id: "unreadable-alias-map",
      origin: "global",
      modelCatalog: {
        aliases: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("model alias map exploded");
            },
          },
        ),
      },
    };
    const healthyAlias = {
      ...basePlugin,
      id: "healthy-alias",
      origin: "global",
      modelCatalog: {
        aliases: {
          broken: {
            get provider() {
              throw new Error("model alias provider exploded");
            },
          },
          kimi: { provider: "moonshot" },
        },
      },
    };

    expect(
      canonicalizeModelCatalogProviderAlias("kimi", {
        cfg: {},
        metadataSnapshot: {
          manifestRegistry: {
            plugins: [unreadableModelCatalog, unreadableAliasMap, healthyAlias],
            diagnostics: [],
          },
        } as never,
      }),
    ).toBe("moonshot");
  });
});
