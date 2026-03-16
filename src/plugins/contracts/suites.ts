import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin, WebSearchProviderPlugin } from "../types.js";

export function installProviderPluginContractSuite(params: { provider: ProviderPlugin }) {
  it("satisfies the base provider plugin contract", () => {
    const { provider } = params;

    expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(provider.label.trim()).not.toBe("");

    if (provider.docsPath) {
      expect(provider.docsPath.startsWith("/")).toBe(true);
    }
    if (provider.aliases) {
      expect(provider.aliases).toEqual([...new Set(provider.aliases)]);
    }
    if (provider.envVars) {
      expect(provider.envVars).toEqual([...new Set(provider.envVars)]);
      expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);
    }

    expect(Array.isArray(provider.auth)).toBe(true);
    const authIds = provider.auth.map((method) => method.id);
    expect(authIds).toEqual([...new Set(authIds)]);
    for (const method of provider.auth) {
      expect(method.id.trim()).not.toBe("");
      expect(method.label.trim()).not.toBe("");
      if (method.hint !== undefined) {
        expect(method.hint.trim()).not.toBe("");
      }
      expect(typeof method.run).toBe("function");
    }
  });
}

export function installWebSearchProviderContractSuite(params: {
  provider: WebSearchProviderPlugin;
  credentialValue: unknown;
}) {
  it("satisfies the base web search provider contract", () => {
    const { provider } = params;

    expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(provider.label.trim()).not.toBe("");
    expect(provider.hint.trim()).not.toBe("");
    expect(provider.placeholder.trim()).not.toBe("");
    expect(provider.signupUrl.startsWith("https://")).toBe(true);
    if (provider.docsUrl) {
      expect(provider.docsUrl.startsWith("http")).toBe(true);
    }

    expect(provider.envVars).toEqual([...new Set(provider.envVars)]);
    expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);

    const searchConfigTarget: Record<string, unknown> = {};
    provider.setCredentialValue(searchConfigTarget, params.credentialValue);
    expect(provider.getCredentialValue(searchConfigTarget)).toEqual(params.credentialValue);

    const config = {
      tools: {
        web: {
          search: {
            provider: provider.id,
            ...searchConfigTarget,
          },
        },
      },
    } as OpenClawConfig;
    const tool = provider.createTool({ config, searchConfig: searchConfigTarget });

    expect(tool).not.toBeNull();
    expect(tool?.description.trim()).not.toBe("");
    expect(tool?.parameters).toEqual(expect.any(Object));
    expect(typeof tool?.execute).toBe("function");
  });
}
