import { describe, expect, it } from "vitest";
import { createPluginRecord } from "../status.test-helpers.js";
import { createPluginRegistryFixture } from "./testkit.js";

describe("provider-only registration surface", () => {
  it("still allows provider-only plugins to register web fetch providers", () => {
    const { config, registry } = createPluginRegistryFixture();
    const record = createPluginRecord({
      id: "provider-only-web-fetch",
      name: "Provider-only Web Fetch",
      source: "/virtual/provider-only-web-fetch/index.ts",
    });
    registry.registry.plugins.push(record);

    const api = registry.createApi(record, {
      config,
      registrationMode: "provider-only",
    });

    api.registerWebFetchProvider({
      id: "provider-only-fetch",
      label: "Provider-only Fetch",
      hint: "Fetch via provider-only registration",
      envVars: ["PROVIDER_ONLY_FETCH_KEY"],
      placeholder: "pof_...",
      signupUrl: "https://example.com/provider-only-fetch",
      credentialPath: "plugins.entries.provider-only-web-fetch.config.webFetch.apiKey",
      getCredentialValue: () => "secret",
      setCredentialValue(target, value) {
        target.apiKey = value;
      },
      createTool: () => ({
        description: "fetch",
        parameters: {},
        execute: async () => ({}),
      }),
    });

    expect(registry.registry.webFetchProviders).toEqual([
      expect.objectContaining({
        pluginId: "provider-only-web-fetch",
        provider: expect.objectContaining({
          id: "provider-only-fetch",
        }),
      }),
    ]);
  });
});
