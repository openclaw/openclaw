import { describe, expect, it } from "vitest";
import {
	pluginRegistrationContractRegistry,
	resolveWebSearchProviderContractEntriesForPluginId,
} from "../../../src/plugins/contracts/registry.js";
import { installWebSearchProviderContractSuite } from "../../../src/plugins/contracts/suites.js";

export function describeWebSearchProviderContracts(pluginId: string) {
	const providerIds =
		pluginRegistrationContractRegistry.find(
			(entry) => entry.pluginId === pluginId,
		)?.webSearchProviderIds ?? [];

	const resolveProviders = () =>
		resolveWebSearchProviderContractEntriesForPluginId(pluginId);

	describe(`${pluginId} web search provider contract registry load`, () => {
		it("loads bundled web search providers", () => {
			expect(resolveProviders().length).toBeGreaterThan(0);
		});
	});

	for (const providerId of providerIds) {
		describe(`${pluginId}:${providerId} web search contract`, () => {
			installWebSearchProviderContractSuite({
				provider: () => {
					const entry = resolveProviders().find(
						(provider) => provider.provider.id === providerId,
					);
					if (!entry) {
						throw new Error(
							`web search provider contract entry missing for ${pluginId}:${providerId}`,
						);
					}
					return entry.provider;
				},
				credentialValue: () => {
					const entry = resolveProviders().find(
						(provider) => provider.provider.id === providerId,
					);
					if (!entry) {
						throw new Error(
							`web search provider contract entry missing for ${pluginId}:${providerId}`,
						);
					}
					return entry.credentialValue;
				},
			});
		});
	}
}
