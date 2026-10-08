import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  getBundledChannelPlugin,
  getBundledChannelSetupPlugin,
} from "../../../channels/plugins/bundled.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../../channels/plugins/read-only.js";
import { getLoadedChannelPlugin } from "../../../channels/plugins/registry.js";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorSequenceResult,
} from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isUnresolvedSecretInputError } from "../../../config/types.secrets.js";
import { findUninspectedPluginDiagnostic } from "../../../plugins/discovery-availability.js";
import { applyPluginDoctorCompatibilitySequence } from "../../../plugins/doctor-compatibility-migration.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { listDoctorConfiguredChannelIds } from "./configured-channel-ids.js";

type ChannelDoctorEntry = {
  id: string;
  doctor: ChannelDoctorAdapter;
};

type ChannelDoctorLookupContext = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
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

const channelDoctorEnumValues: Partial<Record<keyof ChannelDoctorAdapter, ReadonlySet<string>>> = {
  dmAllowFromMode: new Set(["topOnly", "topOrNested", "nestedOnly"]),
  groupModel: new Set(["sender", "route", "hybrid"]),
};

export type ChannelDoctorEmptyAllowlistPolicyHooks = {
  extraWarningsForAccount: NonNullable<ChannelDoctorAdapter["collectEmptyAllowlistExtraWarnings"]>;
} & Required<Pick<ChannelDoctorAdapter, "shouldSkipDefaultEmptyGroupAllowlistWarning">>;

function collectConfiguredChannelIds(cfg: OpenClawConfig): string[] {
  return listDoctorConfiguredChannelIds(cfg, {
    configEntryPolicy: "enabled",
    skipWhenPluginsDisabled: true,
    excludeExplicitlyDisabled: true,
    sort: "codepoint",
  }).filter((channelId) => !isChannelDoctorBlockedByConfig(channelId, cfg));
}

function isChannelDoctorBlockedByConfig(channelId: string, cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  const normalizedChannelId = normalizeOptionalLowercaseString(channelId) ?? channelId;
  if (cfg.plugins?.entries?.[normalizedChannelId]?.enabled === false) {
    return true;
  }
  const channelEntry = (cfg.channels as Record<string, unknown> | undefined)?.[normalizedChannelId];
  return (
    Boolean(channelEntry && typeof channelEntry === "object" && !Array.isArray(channelEntry)) &&
    (channelEntry as { enabled?: unknown }).enabled === false
  );
}

function safelyResolveChannelPlugin<T>(id: string, resolve: (id: string) => T): T | undefined {
  try {
    return resolve(id);
  } catch {
    return undefined;
  }
}

function listReadOnlyChannelDoctorsById(
  context: ChannelDoctorLookupContext,
): Map<string, ChannelDoctorAdapter | undefined> {
  try {
    return new Map(
      resolveReadOnlyChannelPluginsForConfig(context.cfg, {
        ...(context.env ? { env: context.env } : {}),
        includePersistedAuthState: false,
        includeSetupFallbackPlugins: true,
      }).plugins.map(({ id, doctor }) => [id, doctor]),
    );
  } catch {
    return new Map();
  }
}

function mergeDoctorAdapters(
  adapters: Array<ChannelDoctorAdapter | undefined>,
): ChannelDoctorAdapter | undefined {
  const merged: Partial<Record<keyof ChannelDoctorAdapter, unknown>> = {};
  for (const adapter of adapters) {
    if (!adapter) {
      continue;
    }
    for (const [key, value] of Object.entries(adapter) as Array<
      [keyof ChannelDoctorAdapter, unknown]
    >) {
      // Earlier adapters win so read-only installed plugins can override bundled fallbacks.
      if (merged[key] === undefined && isValidChannelDoctorAdapterValue(key, value)) {
        merged[key] = value;
      }
    }
  }
  return Object.keys(merged).length > 0 ? (merged as ChannelDoctorAdapter) : undefined;
}

function isValidChannelDoctorAdapterValue(
  key: keyof ChannelDoctorAdapter,
  value: unknown,
): boolean {
  if (channelDoctorFunctionKeys.has(key)) {
    return typeof value === "function";
  }
  if (channelDoctorBooleanKeys.has(key)) {
    return typeof value === "boolean";
  }
  const enumValues = channelDoctorEnumValues[key];
  if (enumValues) {
    return typeof value === "string" && enumValues.has(value);
  }
  if (key === "legacyConfigRules") {
    return Array.isArray(value);
  }
  return false;
}

function listChannelDoctorEntries(
  context: ChannelDoctorLookupContext,
  channelIds: readonly string[] = collectConfiguredChannelIds(context.cfg),
  readOnlyDoctorsById?: ReadonlyMap<string, ChannelDoctorAdapter | undefined>,
): ChannelDoctorEntry[] {
  const selectedIds = new Set(
    channelIds.filter((id) => !isChannelDoctorBlockedByConfig(id, context.cfg)),
  );
  if (selectedIds.size === 0) {
    return [];
  }
  const doctors = readOnlyDoctorsById ?? listReadOnlyChannelDoctorsById(context);

  const entries: ChannelDoctorEntry[] = [];
  for (const id of selectedIds) {
    const doctor = mergeDoctorAdapters([
      doctors.get(id),
      safelyResolveChannelPlugin(id, getLoadedChannelPlugin)?.doctor,
      safelyResolveChannelPlugin(id, getBundledChannelSetupPlugin)?.doctor,
      safelyResolveChannelPlugin(id, getBundledChannelPlugin)?.doctor,
    ]);
    if (!doctor) {
      continue;
    }
    entries.push({ id, doctor });
  }
  return entries;
}

function preserveUnavailableChannelConfig(
  context: ChannelDoctorLookupContext,
): ChannelDoctorConfigMutation | undefined {
  if (!context.cfg.plugins?.load?.paths?.length) {
    return undefined;
  }
  const warning = findUninspectedPluginDiagnostic(
    loadManifestMetadataSnapshot({ config: context.cfg, env: context.env }).diagnostics,
  );
  return warning ? { config: context.cfg, changes: [], warnings: [warning.message] } : undefined;
}

async function collectChannelDoctorMutations(
  context: ChannelDoctorLookupContext,
  mutate: (
    doctor: ChannelDoctorAdapter,
    cfg: OpenClawConfig,
  ) => ChannelDoctorConfigMutation | undefined | Promise<ChannelDoctorConfigMutation | undefined>,
  channelIds?: readonly string[],
): Promise<ChannelDoctorConfigMutation[]> {
  const preserved = preserveUnavailableChannelConfig(context);
  if (preserved) {
    return [preserved];
  }
  const mutations: ChannelDoctorConfigMutation[] = [];
  let nextCfg = context.cfg;
  for (const { doctor } of listChannelDoctorEntries(context, channelIds)) {
    const mutation = await mutate(doctor, nextCfg);
    if (mutation?.changes.length) {
      mutations.push(mutation);
      nextCfg = mutation.config;
    } else if (mutation?.warnings?.length) {
      mutations.push({ config: nextCfg, changes: [], warnings: mutation.warnings });
    }
  }
  return mutations;
}

/** Build cached empty-allowlist hooks backed by channel doctor adapters. */
export function createChannelDoctorEmptyAllowlistPolicyHooks(
  context: ChannelDoctorLookupContext,
): ChannelDoctorEmptyAllowlistPolicyHooks {
  const readOnlyDoctorsById = listReadOnlyChannelDoctorsById(context);
  const entriesByChannel = new Map<string, ChannelDoctorEntry[]>();
  const entriesForChannel = (channelName: string) => {
    const existing = entriesByChannel.get(channelName);
    if (existing) {
      return existing;
    }
    const entries = listChannelDoctorEntries(context, [channelName], readOnlyDoctorsById);
    entriesByChannel.set(channelName, entries);
    return entries;
  };
  return {
    extraWarningsForAccount: (params) =>
      entriesForChannel(params.channelName).flatMap(
        (entry) => entry.doctor.collectEmptyAllowlistExtraWarnings?.(params) ?? [],
      ),
    shouldSkipDefaultEmptyGroupAllowlistWarning: (params) =>
      entriesForChannel(params.channelName).some(
        (entry) => entry.doctor.shouldSkipDefaultEmptyGroupAllowlistWarning?.(params) === true,
      ),
  };
}

/** Run interactive/non-interactive channel setup repair sequences and collect notes. */
export async function runChannelDoctorConfigSequences(
  params: Parameters<NonNullable<ChannelDoctorAdapter["runConfigSequence"]>>[0],
): Promise<ChannelDoctorSequenceResult> {
  const preserved = preserveUnavailableChannelConfig(params);
  if (preserved) {
    return { changeNotes: [], warningNotes: preserved.warnings ?? [] };
  }
  const changeNotes: string[] = [];
  const infoNotes: string[] = [];
  const warningNotes: string[] = [];
  for (const entry of listChannelDoctorEntries(params)) {
    const result = await entry.doctor.runConfigSequence?.(params);
    if (!result) {
      continue;
    }
    changeNotes.push(...result.changeNotes);
    infoNotes.push(...(result.infoNotes ?? []));
    warningNotes.push(...result.warningNotes);
  }
  return { changeNotes, warningNotes, ...(infoNotes.length > 0 ? { infoNotes } : {}) };
}

/** Collect compatibility migrations from configured channel doctor adapters in order. */
export function collectChannelDoctorCompatibilityMutations(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv } = {},
): ChannelDoctorConfigMutation[] {
  const preserved = preserveUnavailableChannelConfig({ cfg, env: options.env });
  if (preserved) {
    return [preserved];
  }
  const mutation = applyPluginDoctorCompatibilitySequence(
    cfg,
    listChannelDoctorEntries({ cfg, env: options.env }).map(({ id, doctor }) => ({
      pluginId: id,
      normalizeCompatibilityConfig: doctor.normalizeCompatibilityConfig?.bind(doctor),
    })),
  );
  return mutation.changes.length || mutation.warnings?.length ? [mutation] : [];
}

/** Collect stale channel config cleanup mutations from configured channel doctor adapters. */
export async function collectChannelDoctorStaleConfigMutations(
  cfg: OpenClawConfig,
  options: { env?: NodeJS.ProcessEnv; channelIds?: readonly string[] } = {},
): Promise<ChannelDoctorConfigMutation[]> {
  return collectChannelDoctorMutations(
    { cfg, env: options.env },
    (doctor, nextCfg) => doctor.cleanStaleConfig?.({ cfg: nextCfg }),
    options.channelIds,
  );
}

/** Collect channel-specific doctor preview warnings for configured channels. */
export async function collectChannelDoctorPreviewWarnings(
  params: Parameters<NonNullable<ChannelDoctorAdapter["collectPreviewWarnings"]>>[0],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(params)) {
    let lines: string[] | undefined;
    try {
      lines = await entry.doctor.collectPreviewWarnings?.(params);
    } catch (error) {
      if (!isUnresolvedSecretInputError(error)) {
        throw error;
      }
      warnings.push(
        `- channels.${entry.id}: configured SecretRef at ${error.path} is unavailable in doctor preview; skipping secret-backed channel preview checks.`,
      );
      continue;
    }
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

/** Collect warnings for mutable channel allowlists that doctor cannot safely edit. */
export async function collectChannelDoctorMutableAllowlistWarnings(
  params: ChannelDoctorLookupContext,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of listChannelDoctorEntries(params)) {
    const lines = await entry.doctor.collectMutableAllowlistWarnings?.(params);
    if (lines?.length) {
      warnings.push(...lines);
    }
  }
  return warnings;
}

/** Collect channel repair mutations and warning-only repair results from doctor adapters. */
export async function collectChannelDoctorRepairMutations(
  params: Parameters<NonNullable<ChannelDoctorAdapter["repairConfig"]>>[0],
): Promise<ChannelDoctorConfigMutation[]> {
  return collectChannelDoctorMutations(params, (doctor, nextCfg) =>
    doctor.repairConfig?.({
      cfg: nextCfg,
      doctorFixCommand: params.doctorFixCommand,
      ...(params.env ? { env: params.env } : {}),
    }),
  );
}
