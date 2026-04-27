import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type NormalizedPluginsConfig } from "./config-normalization-shared.js";
import { type InstalledPluginIndexStoreInspection, type InstalledPluginIndexStoreOptions } from "./installed-plugin-index-store.js";
import { type InstalledPluginContributionKey, type InstalledPluginIndex, type InstalledPluginIndexRecord, type LoadInstalledPluginIndexParams, type RefreshInstalledPluginIndexParams } from "./installed-plugin-index.js";
export type PluginRegistrySnapshot = InstalledPluginIndex;
export type PluginRegistryRecord = InstalledPluginIndexRecord;
export type PluginRegistryInspection = InstalledPluginIndexStoreInspection;
export type PluginRegistrySnapshotSource = "provided" | "persisted" | "derived";
export type PluginRegistrySnapshotDiagnosticCode = "persisted-registry-disabled" | "persisted-registry-missing" | "persisted-registry-stale-policy";
export type PluginRegistrySnapshotDiagnostic = {
    level: "info" | "warn";
    code: PluginRegistrySnapshotDiagnosticCode;
    message: string;
};
export type PluginRegistrySnapshotResult = {
    snapshot: PluginRegistrySnapshot;
    source: PluginRegistrySnapshotSource;
    diagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};
export declare const DISABLE_PERSISTED_PLUGIN_REGISTRY_ENV = "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY";
export type LoadPluginRegistryParams = LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions & {
    index?: PluginRegistrySnapshot;
    preferPersisted?: boolean;
};
export type PluginRegistryContributionOptions = LoadPluginRegistryParams & {
    includeDisabled?: boolean;
};
export type GetPluginRecordParams = LoadPluginRegistryParams & {
    pluginId: string;
};
export type ResolvePluginContributionOwnersParams = PluginRegistryContributionOptions & {
    contribution: InstalledPluginContributionKey;
    matches: string | ((contributionId: string) => boolean);
};
export type ListPluginContributionIdsParams = PluginRegistryContributionOptions & {
    contribution: InstalledPluginContributionKey;
};
export type ResolveProviderOwnersParams = PluginRegistryContributionOptions & {
    providerId: string;
};
export type ResolveChannelOwnersParams = PluginRegistryContributionOptions & {
    channelId: string;
};
export type ResolveCliBackendOwnersParams = PluginRegistryContributionOptions & {
    cliBackendId: string;
};
export type ResolveSetupProviderOwnersParams = PluginRegistryContributionOptions & {
    setupProviderId: string;
};
export declare function createPluginRegistryIdNormalizer(index: PluginRegistrySnapshot): (pluginId: string) => string;
export declare function normalizePluginsConfigWithRegistry(config: OpenClawConfig["plugins"] | undefined, index: PluginRegistrySnapshot): NormalizedPluginsConfig;
export declare function loadPluginRegistrySnapshotWithMetadata(params?: LoadPluginRegistryParams): PluginRegistrySnapshotResult;
export declare function loadPluginRegistrySnapshot(params?: LoadPluginRegistryParams): PluginRegistrySnapshot;
export declare function listPluginRecords(params?: LoadPluginRegistryParams): readonly PluginRegistryRecord[];
export declare function getPluginRecord(params: GetPluginRecordParams): PluginRegistryRecord | undefined;
export declare function isPluginEnabled(params: GetPluginRecordParams): boolean;
export declare function listPluginContributionIds(params: ListPluginContributionIdsParams): readonly string[];
export declare function resolvePluginContributionOwners(params: ResolvePluginContributionOwnersParams): readonly string[];
export declare function resolveProviderOwners(params: ResolveProviderOwnersParams): readonly string[];
export declare function resolveChannelOwners(params: ResolveChannelOwnersParams): readonly string[];
export declare function resolveCliBackendOwners(params: ResolveCliBackendOwnersParams): readonly string[];
export declare function resolveSetupProviderOwners(params: ResolveSetupProviderOwnersParams): readonly string[];
export declare function inspectPluginRegistry(params?: LoadInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): Promise<PluginRegistryInspection>;
export declare function refreshPluginRegistry(params: RefreshInstalledPluginIndexParams & InstalledPluginIndexStoreOptions): Promise<PluginRegistrySnapshot>;
