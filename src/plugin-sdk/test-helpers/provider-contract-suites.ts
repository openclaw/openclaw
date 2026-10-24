import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import type { WebFetchProviderPlugin } from "../provider-web-fetch-contract.js";
import type { WebSearchProviderPlugin } from "../provider-web-search-contract.js";

type Lazy<T> = T | (() => T);

function resolveLazy<T>(value: Lazy<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

const expectUnique = (values: readonly unknown[] | undefined) =>
  values && expect(values).toEqual([...new Set(values)]);
const expectText = (value: string) => expect(value.trim()).not.toBe("");

function expectWebProviderCredentialContract(
  provider: WebSearchProviderPlugin | WebFetchProviderPlugin,
  credentialValue: unknown,
) {
  expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  [provider.label, provider.hint, provider.placeholder].forEach(expectText);
  expect(provider.signupUrl.startsWith("https://")).toBe(true);
  if (provider.docsUrl) {
    expect(provider.docsUrl.startsWith("http")).toBe(true);
  }

  expectUnique(provider.envVars);
  expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);

  const configTarget: Record<string, unknown> = {};
  provider.setCredentialValue(configTarget, credentialValue);
  expect(provider.getCredentialValue(configTarget)).toEqual(credentialValue);

  expect(typeof provider.createTool).toBe("function");
}

export function installProviderPluginContractSuite(params: { provider: Lazy<ProviderPlugin> }) {
  it("satisfies the base provider plugin contract", () => {
    const provider = resolveLazy(params.provider);
    const authIds = provider.auth.map((method) => method.id);
    const wizardChoiceIds = new Set<string>();
    const expectWizard = (wizard: NonNullable<ProviderPlugin["wizard"]>["setup"]) => {
      if (!wizard) {
        return;
      }
      if (wizard.choiceId) {
        expectText(wizard.choiceId);
        expect(wizardChoiceIds.has(wizard.choiceId)).toBe(false);
        wizardChoiceIds.add(wizard.choiceId);
      }
      if (wizard.methodId) {
        expect(authIds).toContain(wizard.methodId);
      }
      expectUnique(wizard.modelAllowlist?.allowedKeys);
      expectUnique(wizard.modelAllowlist?.initialSelections);
    };

    expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expectText(provider.label);

    if (provider.docsPath) {
      expect(provider.docsPath.startsWith("/")).toBe(true);
    }
    expectUnique(provider.aliases);
    if (provider.envVars) {
      expectUnique(provider.envVars);
      expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);
    }

    expect(Array.isArray(provider.auth)).toBe(true);
    expectUnique(authIds);
    for (const method of provider.auth) {
      [method.id, method.label].forEach(expectText);
      if (method.hint !== undefined) {
        expectText(method.hint);
      }
      expectWizard(method.wizard);
      expect(typeof method.run).toBe("function");
    }

    if (provider.wizard?.setup || provider.wizard?.modelPicker) {
      expect(provider.auth.length).toBeGreaterThan(0);
    }
    expectWizard(provider.wizard?.setup);
    if (provider.wizard?.modelPicker?.methodId) {
      expect(authIds).toContain(provider.wizard.modelPicker.methodId);
    }
  });
}

export function installWebSearchProviderContractSuite(params: {
  provider: Lazy<WebSearchProviderPlugin>;
  credentialValue: Lazy<unknown>;
}) {
  it("satisfies the base web search provider contract", () => {
    const provider = resolveLazy(params.provider);
    expectWebProviderCredentialContract(provider, resolveLazy(params.credentialValue));
    if (provider.runSetup) {
      expect(typeof provider.runSetup).toBe("function");
    }
  });
}

export function installWebFetchProviderContractSuite(params: {
  provider: Lazy<WebFetchProviderPlugin>;
  credentialValue: Lazy<unknown>;
  pluginId?: string;
}) {
  it("satisfies the base web fetch provider contract", () => {
    const provider = resolveLazy(params.provider);
    const credentialValue = resolveLazy(params.credentialValue);

    expectWebProviderCredentialContract(provider, credentialValue);
    expectText(provider.credentialPath);
    if (provider.inactiveSecretPaths) {
      expectUnique(provider.inactiveSecretPaths);
      expect(provider.inactiveSecretPaths).toContain(provider.credentialPath);
    }

    if (provider.setConfiguredCredentialValue && provider.getConfiguredCredentialValue) {
      const configTarget = {} as OpenClawConfig;
      provider.setConfiguredCredentialValue(configTarget, credentialValue);
      expect(provider.getConfiguredCredentialValue(configTarget)).toEqual(credentialValue);
    }

    if (provider.applySelectionConfig && params.pluginId) {
      const applied = provider.applySelectionConfig({} as OpenClawConfig);
      expect(applied.plugins?.entries?.[params.pluginId]?.enabled).toBe(true);
    }
  });
}
