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
});
