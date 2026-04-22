import {
  getBundledChannelPlugin,
  getBundledChannelSetupPlugin,
} from "../../../channels/plugins/bundled.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../../channels/plugins/read-only.js";
import { getLoadedChannelPlugin } from "../../../channels/plugins/registry.js";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorEmptyAllowlistAccountContext,
  ChannelDoctorSequenceResult,
} from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type ChannelDoctorEntry = {
  doctor: ChannelDoctorAdapter;
};

type ChannelDoctorLookupContext = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

type ChannelDoctorEmptyAllowlistLookupParams = ChannelDoctorEmptyAllowlistAccountContext & {
  cfg?: OpenClawConfig;
};

const channelDoctorFunctionKeys = new Set<keyof ChannelDoctorAdapter>([
  "normalizeCompatibilityConfig",
  "collectPreviewWarnings",
  "collectMutableAllowlistWarnings",
  "repairConfig",
  "runConfigSequence",
  "cleanStaleConfig",
  "collectEmptyAllowlistExtraWarnings",
  "shouldSkipDefaultEmptyGroupAllowlistWarning",
]);

const channelDoctorBooleanKeys = new Set<keyof ChannelDoctorAdapter>([
  "groupAllowFromFallbackToAllowFrom",
  "warnOnEmptyGroupSenderAllowlist",
]);

const channelDoctorStringEnumValues: Partial<
  Record<keyof ChannelDoctorAdapter, ReadonlySet<string>>
> = {
  dmAllowFromMode: new Set(["topOnly", "topOrNested", "nestedOnly"]),
  groupModel: new Set(["sender", "route", "hybrid"]),
};

export type ChannelDoctorEmptyAllowlistPolicyHooks = {
  extraWarningsForAccount: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
  shouldSkipDefaultEmptyGroupAllowlistWarning: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

function collectConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  const channels =
    cfg.channels && typeof cfg.channels === "object" && !Array.isArray(cfg.channels)
      ? cfg.channels
      : null;
  if (!channels) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults")
    .toSorted();
}

function safeGetLoadedChannelPlugin(id: string) {
  try {
    return getLoadedChannelPlugin(id);
  } catch {
    return undefined;
  }
}

function safeGetBundledChannelSetupPlugin(id: string) {
  try {
    return getBundledChannelSetupPlugin(id);
  } catch {
    return undefined;
  }
}

function safeGetBundledChannelPlugin(id: string) {
  try {
    return getBundledChannelPlugin(id);
  } catch {
    return undefined;
  }
}

function safeListReadOnlyChannelPlugins(context: ChannelDoctorLookupContext) {
  try {
    return resolveReadOnlyChannelPluginsForConfig(context.cfg, {
      ...(context.env ? { env: context.env } : {}),
      includePersistedAuthState: false,
    }).plugins;
  } catch {
    return [];
  }
}

function mergeDoctorAdapters(
  adapters: Array<ChannelDoctorAdapter | undefined>,
): ChannelDoctorAdapter | undefined {
  const merged: Record<string, unknown> = {};
  for (const adapter of adapters) {
    if (!adapter) {
      continue;
    }
    for (const [key, value] of Object.entries(adapter)) {
      if (merged[key] === undefined && isValidChannelDoctorAdapterValue(key, value)) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length > 0 ? (merged as ChannelDoctorAdapter) : undefined;
}

function isValidChannelDoctorAdapterValue(key: string, value: unknown): boolean {
  if (value == null) {
    return false;
  }
  const typedKey = key as keyof ChannelDoctorAdapter;
  if (channelDoctorFunctionKeys.has(typedKey)) {
    return typeof value === "function";
  }
  if (channelDoctorBooleanKeys.has(typedKey)) {
    return typeof value === "boolean";
  }
  const enumValues = channelDoctorStringEnumValues[typedKey];
  if (enumValues) {
    return typeof value === "string" && enumValues.has(value);
  }
  if (typedKey === "legacyConfigRules") {
    return Array.isArray(value);
  }
  return false;
}

function listChannelDoctorEntries(
  channelIds: readonly string[],
  context: ChannelDoctorLookupContext,
): ChannelDoctorEntry[] {
  if (channelIds.length === 0) {
    return [];
  }
  const byId = new Map<string, ChannelDoctorEntry>();
  const selectedIds = new Set(channelIds);
  const readOnlyPlugins = safeListReadOnlyChannelPlugins(context).filter((plugin) =>
    selectedIds.has(plugin.id),
  );
  const readOnlyPluginsById = new Map(readOnlyPlugins.map((plugin) => [plugin.id, plugin]));

  for (const id of selectedIds) {
    const doctor = mergeDoctorAdapters([
      readOnlyPluginsById.get(id)?.doctor,
      safeGetLoadedChannelPlugin(id)?.doctor,
      safeGetBundledChannelSetupPlugin(id)?.doctor,
      safeGetBundledChannelPlugin(id)?.doctor,
    ]);
    if (!doctor) {
      continue;
    }
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { doctor });
    }
  }
  return [...byId.values()];
}

function toPluginEmptyAllowlistContext({
  cfg: _cfg,
  ...params
}: ChannelDoctorEmptyAllowlistLookupParams): ChannelDoctorEmptyAllowlistAccountContext {
  return params;
}

function collectEmptyAllowlistExtraWarningsForEntries(
  entries: readonly ChannelDoctorEntry[],
  params: ChannelDoctorEmptyAllowlistLookupParams,
): string[] {
  const warnings: string[] = [];
  const pluginParams = toPluginEmptyAllowlistContext(params);
  for (const entry of entries) {
    const lines = entry.doctor.collectEmptyAllowlistExtraWarnings?.(pluginParams);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

function shouldSkipDefaultEmptyGroupAllowlistWarningForEntries(
  entries: readonly ChannelDoctorEntry[],
  params: ChannelDoctorEmptyAllowlistLookupParams,
): boolean {
  const pluginParams = toPluginEmptyAllowlistContext(params);
  return entries.some(
    (entry) => entry.doctor.shouldSkipDefaultEmptyGroupAllowlistWarning?.(pluginParams) === true,
  );
}

export function createChannelDoctorEmptyAllowlistPolicyHooks(
  context: ChannelDoctorLookupContext,
): ChannelDoctorEmptyAllowlistPolicyHooks {
  const entriesByChannel = new Map<string, ChannelDoctorEntry[]>();
  const entriesForChannel = (channelName: string) => {
    const existing = entriesByChannel.get(channelName);
    if (existing) {
      return existing;
    }
    const entries = listChannelDoctorEntries([channelName], context);
    entriesByChannel.set(channelName, entries);
    return entries;
  };
  return {
    extraWarningsForAccount: (params) =>
      collectEmptyAllowlistExtraWarningsForEntries(entriesForChannel(params.channelName), params),
    shouldSkipDefaultEmptyGroupAllowlistWarning: (params) =>
      shouldSkipDefaultEmptyGroupAllowlistWarningForEntries(
        entriesForChannel(params.channelName),
        params,
      ),
  };
}

export async function runChannelDoctorConfigSequences(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): Promise<ChannelDoctorSequenceResult> {
  const changeNotes: string[] = [];
  const warningNotes: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const result = await entry.doctor.runConfigSequence?.(params);
    if (!result) {
      continue;
    }
    changeNotes.push(...result.changeNotes);
    warningNotes.push(...result.warningNotes);
  }
  return { changeNotes, warningNotes };
}

export function collectChannelDoctorCompatibilityMutations(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): ChannelDoctorConfigMutation[] {
  const channelIds = collectConfiguredChannelIds(cfg);
  if (channelIds.length === 0) {
    return [];
  }
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = cfg;
  for (const entry of listChannelDoctorEntries(channelIds, { cfg, env: options.env })) {
    const mutation = entry.doctor.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

export async function collectChannelDoctorStaleConfigMutations(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ChannelDoctorConfigMutation[]> {
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = cfg;
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(cfg), {
    cfg,
    env: options.env,
  })) {
    const mutation = await entry.doctor.cleanStaleConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

export async function collectChannelDoctorPreviewWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const lines = await entry.doctor.collectPreviewWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

export async function collectChannelDoctorMutableAllowlistWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const lines = await entry.doctor.collectMutableAllowlistWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

export async function collectChannelDoctorRepairMutations(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ChannelDoctorConfigMutation[]> {
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = params.cfg;
  for (const entry of listChannelDoctorEntries(collectConfiguredChannelIds(params.cfg), {
    cfg: params.cfg,
    env: params.env,
  })) {
    const mutation = await entry.doctor.repairConfig?.({
      cfg: nextCfg,
      doctorFixCommand: params.doctorFixCommand,
    });
    if (!mutation || mutation.changes.length === 0) {
      if (mutation?.warnings?.length) {
        mutations.push({ config: nextCfg, changes: [], warnings: mutation.warnings });
      }
      continue;
    }
    mutations.push(mutation);
    nextCfg = mutation.config;
  }
  return mutations;
}

export function collectChannelDoctorEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistLookupParams,
): string[] {
  return collectEmptyAllowlistExtraWarningsForEntries(
    listChannelDoctorEntries([params.channelName], {
      cfg: params.cfg ?? {},
    }),
    params,
  );
}

export function shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning(
  params: ChannelDoctorEmptyAllowlistLookupParams,
): boolean {
  return shouldSkipDefaultEmptyGroupAllowlistWarningForEntries(
    listChannelDoctorEntries([params.channelName], {
      cfg: params.cfg ?? {},
    }),
    params,
  );
}
