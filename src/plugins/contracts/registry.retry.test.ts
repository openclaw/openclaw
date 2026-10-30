import { afterEach, describe, expect, it, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import type { ProviderPlugin } from "../types.js";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

function mockRuntimeFallback() {
  const loadBundledCapabilityRuntimeRegistry = vi.fn(() => {
    throw new Error("public artifact should not hit bundled runtime registry");
  });
  // mock-isolation: public-artifact lookup must never initialize bundled provider runtimes.
  vi.doMock("../bundled-capability-runtime.js", () => ({ loadBundledCapabilityRuntimeRegistry }));
  return loadBundledCapabilityRuntimeRegistry;
}

function makeProvider(label: string): ProviderPlugin {
  return { id: "openai", label, auth: [] };
}

describe("plugin contract registry public artifacts", () => {
  it("uses provider public artifacts before falling back to the bundled runtime registry", async () => {
    const loadBundledCapabilityRuntimeRegistry = mockRuntimeFallback();
    const resolveBundledExplicitProviderContractsFromPublicArtifacts = vi.fn(() => [
      { pluginId: "openai", provider: makeProvider("OpenAI") },
      { pluginId: "openai", provider: makeProvider("OpenAI Codex") },
    ]);

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
    const loadBundledCapabilityRuntimeRegistry = mockRuntimeFallback();
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
