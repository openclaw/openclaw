import { listBundledWebSearchProviders as listBundledWebSearchProviderEntries } from "./bundled-web-search.js";
import { resolveEffectiveEnableState } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderEntry } from "./types.js";
import {
	resolveBundledWebSearchResolutionConfig,
	sortWebSearchProviders,
} from "./web-search-providers.shared.js";

function listBundledWebSearchProviders(): PluginWebSearchProviderEntry[] {
	return sortWebSearchProviders(listBundledWebSearchProviderEntries());
}

export function resolveBundledPluginWebSearchProviders(params: {
	config?: PluginLoadOptions["config"];
	workspaceDir?: string;
	env?: PluginLoadOptions["env"];
	bundledAllowlistCompat?: boolean;
	onlyPluginIds?: readonly string[];
}): PluginWebSearchProviderEntry[] {
	const { config, normalized } =
		resolveBundledWebSearchResolutionConfig(params);
	const onlyPluginIdSet =
		params.onlyPluginIds && params.onlyPluginIds.length > 0
			? new Set(params.onlyPluginIds)
			: null;

	return listBundledWebSearchProviders().filter((provider) => {
		if (onlyPluginIdSet && !onlyPluginIdSet.has(provider.pluginId)) {
			return false;
		}
		return resolveEffectiveEnableState({
			id: provider.pluginId,
			origin: "bundled",
			config: normalized,
			rootConfig: config,
		}).enabled;
	});
}
