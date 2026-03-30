import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
	withBundledPluginAllowlistCompat,
	withBundledPluginEnablementCompat,
	withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveBundledWebSearchPluginIds } from "./bundled-web-search.js";
import {
	type NormalizedPluginsConfig,
	normalizePluginsConfig,
} from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import type { PluginWebSearchProviderEntry } from "./types.js";

function resolveBundledWebSearchCompatPluginIds(params: {
	config?: PluginLoadOptions["config"];
	workspaceDir?: string;
	env?: PluginLoadOptions["env"];
}): string[] {
	return resolveBundledWebSearchPluginIds({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
	});
}

function compareWebSearchProvidersAlphabetically(
	left: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
	right: Pick<PluginWebSearchProviderEntry, "id" | "pluginId">,
): number {
	return (
		left.id.localeCompare(right.id) ||
		left.pluginId.localeCompare(right.pluginId)
	);
}

export function sortWebSearchProviders(
	providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
	return providers.toSorted(compareWebSearchProvidersAlphabetically);
}

export function sortWebSearchProvidersForAutoDetect(
	providers: PluginWebSearchProviderEntry[],
): PluginWebSearchProviderEntry[] {
	return providers.toSorted((left, right) => {
		const leftOrder = left.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = right.autoDetectOrder ?? Number.MAX_SAFE_INTEGER;
		if (leftOrder !== rightOrder) {
			return leftOrder - rightOrder;
		}
		return compareWebSearchProvidersAlphabetically(left, right);
	});
}

export function resolveBundledWebSearchResolutionConfig(params: {
	config?: PluginLoadOptions["config"];
	workspaceDir?: string;
	env?: PluginLoadOptions["env"];
	bundledAllowlistCompat?: boolean;
}): {
	config: PluginLoadOptions["config"];
	normalized: NormalizedPluginsConfig;
} {
	const autoEnabledConfig =
		params.config !== undefined
			? applyPluginAutoEnable({
					config: params.config,
					env: params.env ?? process.env,
				}).config
			: undefined;
	const bundledCompatPluginIds = resolveBundledWebSearchCompatPluginIds({
		config: autoEnabledConfig,
		workspaceDir: params.workspaceDir,
		env: params.env,
	});
	const allowlistCompat = params.bundledAllowlistCompat
		? withBundledPluginAllowlistCompat({
				config: autoEnabledConfig,
				pluginIds: bundledCompatPluginIds,
			})
		: autoEnabledConfig;
	const enablementCompat = withBundledPluginEnablementCompat({
		config: allowlistCompat,
		pluginIds: bundledCompatPluginIds,
	});
	const config = withBundledPluginVitestCompat({
		config: enablementCompat,
		pluginIds: bundledCompatPluginIds,
		env: params.env,
	});

	return {
		config,
		normalized: normalizePluginsConfig(config?.plugins),
	};
}
