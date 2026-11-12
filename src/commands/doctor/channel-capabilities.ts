import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import { findBundledChannelCatalogMetadata } from "../../channels/bundled-channel-catalog-read.js";
import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginPackageChannelDoctorCapabilities } from "../../plugins/manifest.js";

type DoctorChannelCapabilities = Required<
  Omit<PluginPackageChannelDoctorCapabilities, "openDmRequiresAllowFromWildcard">
> &
  Pick<PluginPackageChannelDoctorCapabilities, "openDmRequiresAllowFromWildcard">;

const DEFAULT_DOCTOR_CHANNEL_CAPABILITIES: DoctorChannelCapabilities = {
  dmAllowFromMode: "topOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: true,
  warnOnEmptyGroupSenderAllowlist: true,
};

function mergeDoctorChannelCapabilities(
  capabilities?: PluginPackageChannelDoctorCapabilities,
): DoctorChannelCapabilities {
  const valueFor = <K extends keyof DoctorChannelCapabilities>(key: K) =>
    capabilities?.[key] ?? DEFAULT_DOCTOR_CHANNEL_CAPABILITIES[key];
  return {
    dmAllowFromMode: valueFor("dmAllowFromMode"),
    ...(typeof capabilities?.openDmRequiresAllowFromWildcard === "boolean"
      ? { openDmRequiresAllowFromWildcard: capabilities.openDmRequiresAllowFromWildcard }
      : {}),
    groupModel: valueFor("groupModel"),
    groupAllowFromFallbackToAllowFrom: valueFor("groupAllowFromFallbackToAllowFrom"),
    warnOnEmptyGroupSenderAllowlist: valueFor("warnOnEmptyGroupSenderAllowlist"),
  };
}

export function getDoctorChannelCapabilities(channelName?: string): DoctorChannelCapabilities {
  if (!channelName) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }

  const catalogCapabilities = findBundledChannelCatalogMetadata(channelName)?.doctorCapabilities;
  if (catalogCapabilities) {
    return mergeDoctorChannelCapabilities(catalogCapabilities);
  }

  const channelId = normalizeAnyChannelId(channelName);
  if (!channelId) {
    return DEFAULT_DOCTOR_CHANNEL_CAPABILITIES;
  }
  const pluginDoctor =
    getChannelPlugin(channelId)?.doctor ?? getBundledChannelPlugin(channelId)?.doctor;
  return mergeDoctorChannelCapabilities(
    pluginDoctor || findBundledChannelCatalogMetadata(channelId)?.doctorCapabilities,
  );
}

type DoctorChannelAccountIds = {
  configured: string[];
  runtime: string[];
};

function findReadOnlyChannelPlugin(params: {
  cfg: OpenClawConfig;
  channelId: string | null;
  channelName: string;
  env?: NodeJS.ProcessEnv;
}) {
  const channelId =
    params.channelId ??
    findBundledChannelCatalogMetadata(params.channelName)?.id ??
    normalizeOptionalLowercaseString(params.channelName);
  if (!channelId) {
    return undefined;
  }
  try {
    const { plugins } = resolveReadOnlyChannelPluginsForConfig(params.cfg, {
      ...(params.env ? { env: params.env } : {}),
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });
    return plugins.find((plugin) => plugin.id === channelId);
  } catch {
    // Doctor stays conservative when configured plugins cannot be loaded.
    return undefined;
  }
}

/** Resolve configured and runtime account ids through the channel plugin's own semantics. */
export async function resolveDoctorChannelAccountIds(
  channelName: string,
  cfg: OpenClawConfig,
  configuredAccountIds: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DoctorChannelAccountIds | undefined> {
  const channelId = normalizeAnyChannelId(channelName);
  try {
    // Doctor inspects config without starting channels, so the live plugin
    // registry can be empty. Reuse Doctor's config-driven read-only loader for
    // bundled and configured external channels in that case.
    const plugin =
      (channelId
        ? (getChannelPlugin(channelId) ?? getBundledChannelPlugin(channelId))
        : undefined) ??
      findReadOnlyChannelPlugin({ cfg, channelId, channelName, env: options.env });
    if (!plugin) {
      return undefined;
    }
    const resolveAccountIds = async (accountIds: string[]): Promise<string[] | undefined> => {
      const resolved = await Promise.all(
        accountIds.map(async (accountId) => {
          const account = await resolveChannelAccount({ plugin, cfg, accountId });
          const resolvedId = asOptionalObjectRecord(account)?.accountId;
          return typeof resolvedId === "string" && resolvedId ? resolvedId : undefined;
        }),
      );
      return resolved.every((accountId): accountId is string => accountId !== undefined)
        ? resolved
        : undefined;
    };
    const configured = await resolveAccountIds(configuredAccountIds);
    const runtime = await resolveAccountIds(plugin.config.listAccountIds(cfg));
    return configured && runtime ? { configured, runtime } : undefined;
  } catch {
    // Keep doctor warnings conservative when a plugin cannot inspect its account set.
    return undefined;
  }
}
