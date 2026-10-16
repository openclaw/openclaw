// Public artifact contract tests keep metadata loading separate from runtime activation.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import type { ProviderPlugin } from "../types.js";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("plugin contract registry public artifacts", () => {
  it("uses provider public artifacts before falling back to the bundled runtime registry", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn(() => {
      throw new Error("provider contract public artifact should not hit bundled runtime registry");
    });
    const resolveBundledExplicitProviderContractsFromPublicArtifacts = vi.fn(() => [
      {
        pluginId: "openai",
        provider: {
          id: "openai",
          label: "OpenAI",
          docsPath: "/providers/openai",
          auth: [
            {
              id: "api-key",
              label: "API key",
              kind: "api_key",
              run: async () => ({ profiles: [] }),
            },
          ],
        } as ProviderPlugin,
      },
      {
        pluginId: "openai",
        provider: {
          id: "openai",
          label: "OpenAI Codex",
          docsPath: "/providers/openai",
          auth: [
            {
              id: "oauth",
              label: "OAuth",
              kind: "oauth",
              run: async () => ({ profiles: [] }),
            },
          ],
        } as ProviderPlugin,
      },
    ]);

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));
    vi.doMock("../provider-contract-public-artifacts.js", () => ({
      resolveBundledExplicitProviderContractsFromPublicArtifacts,
    }));

    const { resolveProviderContractProvidersForPluginIds } = await import("./registry.js");

    expect(
      resolveProviderContractProvidersForPluginIds(["openai"]).map((provider) => provider.id),
    ).toEqual(["openai"]);
    expect(resolveBundledExplicitProviderContractsFromPublicArtifacts).toHaveBeenCalledTimes(1);
    expect(loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });

  it("uses web search public artifacts before falling back to the bundled runtime registry", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn(() => {
      throw new Error(
        "web search contract public artifact should not hit bundled runtime registry",
      );
    });
    const resolveBundledExplicitWebSearchProvidersFromPublicArtifacts = vi.fn(() => [
      {
        pluginId: "google",
        id: "gemini",
        label: "Gemini",
        hint: "Search with Gemini",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "GEMINI_API_KEY",
        signupUrl: "https://aistudio.google.com",
        credentialPath: "plugins.entries.google.config.webSearch.apiKey",
        requiresCredential: true,
        getCredentialValue: () => undefined,
        setCredentialValue() {},
        createTool: () => ({
          description: "search",
          parameters: {},
          execute: async () => ({}),
        }),
        credentialValue: "AIzaSyDUMMY",
      },
    ]);

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));
    vi.doMock("../web-provider-public-artifacts.explicit.js", () => ({
      resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    }));

    const { resolveWebSearchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebSearchProviderContractEntriesForPluginId("google").map(
        (entry) => entry.provider.id,
      ),
    ).toEqual(["gemini"]);
    expect(resolveBundledExplicitWebSearchProvidersFromPublicArtifacts).toHaveBeenCalledTimes(1);
    expect(loadBundledCapabilityRuntimeRegistry).not.toHaveBeenCalled();
  });
});
