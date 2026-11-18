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
  it("scopes provider load failures and prefers public artifacts over the runtime registry", async () => {
    const loadBundledCapabilityRuntimeRegistry = mockRuntimeFallback();
    let artifactsAvailable = false;
    const resolveBundledExplicitProviderContractsFromPublicArtifacts = vi.fn(() =>
      artifactsAvailable
        ? [
            { pluginId: "openai", provider: makeProvider("OpenAI") },
            { pluginId: "openai", provider: makeProvider("OpenAI Codex") },
          ]
        : null,
    );

    vi.doMock("../provider-contract-public-artifacts.js", () => ({
      resolveBundledExplicitProviderContractsFromPublicArtifacts,
    }));

    const {
      resolveProviderContractEntriesForPluginId,
      resolveProviderContractProvidersForPluginIds,
    } = await import("./registry.js");

    expect(() => resolveProviderContractProvidersForPluginIds(["openai"])).toThrow(
      "public artifact should not hit bundled runtime registry",
    );
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);

    artifactsAvailable = true;
    expect(
      resolveProviderContractEntriesForPluginId("openai").map((entry) => entry.provider.label),
    ).toEqual(["OpenAI", "OpenAI Codex"]);

    expect(
      resolveProviderContractProvidersForPluginIds(["openai", "openai"]).map(({ id, label }) => ({
        id,
        label,
      })),
    ).toEqual([{ id: "openai", label: "OpenAI Codex" }]);
    expect(resolveBundledExplicitProviderContractsFromPublicArtifacts).toHaveBeenCalledTimes(3);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);
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
