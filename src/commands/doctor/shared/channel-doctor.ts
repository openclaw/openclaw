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

function listChannelDoctorEntries(
  channelIds: readonly string[],
  context: ChannelDoctorLookupContext,
): ChannelDoctorEntry[] {
  const byId = new Map<string, ChannelDoctorEntry>();
  const selectedIds = new Set(channelIds);
  const readOnlyPlugins = safeListReadOnlyChannelPlugins(context).filter((plugin) =>
    selectedIds.has(plugin.id),
  );
  const readOnlyDoctorPluginIds = new Set(
    readOnlyPlugins.filter((plugin) => plugin.doctor).map((plugin) => plugin.id),
  );
  const plugins = [
    ...readOnlyPlugins.filter((plugin) => plugin.doctor),
    ...channelIds.flatMap((id) => {
      if (readOnlyDoctorPluginIds.has(id)) {
        return [];
      }
      const loadedPlugin = safeGetLoadedChannelPlugin(id);
      if (loadedPlugin?.doctor) {
        return [loadedPlugin];
      }
      const bundledSetupPlugin = safeGetBundledChannelSetupPlugin(id);
      if (bundledSetupPlugin?.doctor) {
        return [bundledSetupPlugin];
      }
      const bundledPlugin = safeGetBundledChannelPlugin(id);
      return bundledPlugin?.doctor ? [bundledPlugin] : [];
    }),
  ];
  for (const plugin of plugins) {
    if (!plugin.doctor) {
      continue;
    }
    const existing = byId.get(plugin.id);
    if (!existing) {
      byId.set(plugin.id, { doctor: plugin.doctor });
    }
  }
  return [...byId.values()];
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
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries([params.channelName], {
    cfg: params.cfg ?? {},
    env: params.env,
  })) {
    const lines = entry.doctor.collectEmptyAllowlistExtraWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

export function shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): boolean {
  return listChannelDoctorEntries([params.channelName], {
    cfg: params.cfg ?? {},
    env: params.env,
  }).some((entry) => entry.doctor.shouldSkipDefaultEmptyGroupAllowlistWarning?.(params) === true);
}
