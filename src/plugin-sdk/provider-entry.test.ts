import { describe, expect, it } from "vitest";
import { capturePluginRegistration } from "../plugins/captured-registration.js";
import type { ProviderCatalogContext } from "../plugins/types.js";
import { defineSingleProviderPluginEntry } from "./provider-entry.js";

function createCatalogContext(
  config: ProviderCatalogContext["config"] = {},
): ProviderCatalogContext {
  return {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: "test-key" }),
    resolveProviderAuth: () => ({
      apiKey: "test-key",
      mode: "api_key",
      source: "env",
    }),
  };
}

describe("defineSingleProviderPluginEntry", () => {
  it("registers a single provider with default wizard metadata", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "demo",
      name: "Demo Provider",
      description: "Demo provider plugin",
      provider: {
        label: "Demo",
        docsPath: "/providers/demo",
        auth: [
          {
            methodId: "api-key",
            label: "Demo API key",
            hint: "Shared key",
            optionKey: "demoApiKey",
            flagName: "--demo-api-key",
            envVar: "DEMO_API_KEY",
            promptMessage: "Enter Demo API key",
            defaultModel: "demo/default",
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://api.demo.test/v1",
            models: [{ id: "default", name: "Default" }],
          }),
        },
      },
    });

    const captured = capturePluginRegistration(entry);
    expect(captured.providers).toHaveLength(1);
    const provider = captured.providers[0];
    expect(provider).toMatchObject({
      id: "demo",
      label: "Demo",
      docsPath: "/providers/demo",
      envVars: ["DEMO_API_KEY"],
    });
    expect(provider?.auth).toHaveLength(1);
    expect(provider?.auth[0]).toMatchObject({
      id: "api-key",
      label: "Demo API key",
      hint: "Shared key",
    });
    expect(provider?.auth[0]?.wizard).toMatchObject({
      choiceId: "demo-api-key",
      choiceLabel: "Demo API key",
      groupId: "demo",
      groupLabel: "Demo",
      groupHint: "Shared key",
      methodId: "api-key",
    });

    const catalog = await provider?.catalog?.run(createCatalogContext());
    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "test-key",
        baseUrl: "https://api.demo.test/v1",
        models: [{ id: "default", name: "Default" }],
      },
    });
  });

  it("supports provider overrides, explicit env vars, and extra registration", async () => {
    const entry = defineSingleProviderPluginEntry({
      id: "gateway-plugin",
      name: "Gateway Provider",
      description: "Gateway provider plugin",
      provider: {
        id: "gateway",
        label: "Gateway",
        aliases: ["gw"],
        docsPath: "/providers/gateway",
        envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
        auth: [
          {
            methodId: "api-key",
            label: "Gateway key",
            hint: "Primary key",
            optionKey: "gatewayKey",
            flagName: "--gateway-key",
            envVar: "GATEWAY_KEY",
            promptMessage: "Enter Gateway key",
            wizard: {
              groupId: "shared-gateway",
              groupLabel: "Shared Gateway",
            },
          },
        ],
        catalog: {
          buildProvider: () => ({
            api: "openai-completions",
            baseUrl: "https://gateway.test/v1",
            models: [{ id: "router", name: "Router" }],
          }),
          allowExplicitBaseUrl: true,
        },
        capabilities: {
          transcriptToolCallIdMode: "strict9",
        },
      },
      register(api) {
        api.registerWebSearchProvider({
          id: "gateway-search",
          label: "Gateway Search",
          hint: "search",
          envVars: [],
          placeholder: "",
          signupUrl: "https://example.com",
          credentialPath: "tools.web.search.gateway.apiKey",
          getCredentialValue: () => undefined,
          setCredentialValue() {},
          createTool: () => ({
            description: "search",
            parameters: {},
            execute: async () => ({}),
          }),
        });
      },
    });

    const captured = capturePluginRegistration(entry);
    expect(captured.providers).toHaveLength(1);
    expect(captured.webSearchProviders).toHaveLength(1);

    const provider = captured.providers[0];
    expect(provider).toMatchObject({
      id: "gateway",
      label: "Gateway",
      aliases: ["gw"],
      envVars: ["GATEWAY_KEY", "SECONDARY_KEY"],
      capabilities: {
        transcriptToolCallIdMode: "strict9",
      },
    });
    expect(provider?.auth[0]?.wizard).toMatchObject({
      choiceId: "gateway-api-key",
      groupId: "shared-gateway",
      groupLabel: "Shared Gateway",
      groupHint: "Primary key",
    });

    const catalog = await provider?.catalog?.run(
      createCatalogContext({
        models: {
          providers: {
            gateway: {
              baseUrl: "https://override.test/v1",
            },
          },
        },
      }),
    );
    expect(catalog).toEqual({
      provider: {
        api: "openai-completions",
        apiKey: "test-key",
        baseUrl: "https://override.test/v1",
        models: [{ id: "router", name: "Router" }],
      },
    });
  });
});
