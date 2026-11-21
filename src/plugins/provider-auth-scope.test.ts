import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveProviderAuthScope } from "./provider-auth-scope.js";

function snapshot(scope?: "agent" | "plugin") {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "fixture",
        providers: ["fixture"],
        providerAuthAliases: { "auth-alias": "fixture" },
        modelCatalog: {
          providers: { fixture: { authScope: scope, models: [] } },
          aliases: { "catalog-alias": { provider: "fixture" } },
        },
      },
    ],
  });
}

describe("static provider physical credential owner", () => {
  it.each(["fixture", "auth-alias", "catalog-alias"])(
    "retains plugin scope without execution for %s",
    (provider) => {
      expect(
        resolveProviderAuthScope({ provider, pluginMetadataSnapshot: snapshot("plugin") }),
      ).toBe("plugin");
    },
  );
  it("defaults undeclared scope to agent and honors an explicitly empty selection", () => {
    expect(
      resolveProviderAuthScope({ provider: "fixture", pluginMetadataSnapshot: snapshot() }),
    ).toBe("agent");
    expect(
      resolveProviderAuthScope({
        provider: "fixture",
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      }),
    ).toBe("agent");
  });
  it("fails closed when distinct declared owners disagree", () => {
    const metadata = snapshot("plugin");
    metadata.manifestRegistry.plugins.push({
      ...metadata.manifestRegistry.plugins[0]!,
      id: "other-owner",
      modelCatalog: { providers: { fixture: { authScope: "agent", models: [] } } },
    });
    expect(() =>
      resolveProviderAuthScope({ provider: "fixture", pluginMetadataSnapshot: metadata }),
    ).toThrow("conflicting static credential owners");
  });
  it("uses the first declaration of a duplicate plugin id", () => {
    const metadata = snapshot("plugin");
    metadata.manifestRegistry.plugins.push({
      ...metadata.manifestRegistry.plugins[0]!,
      modelCatalog: { providers: { fixture: { authScope: "agent", models: [] } } },
    });
    expect(
      resolveProviderAuthScope({ provider: "fixture", pluginMetadataSnapshot: metadata }),
    ).toBe("plugin");
  });
});
