import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelAccount } from "../channels/account-resolution.js";
import { hasConfiguredUnavailableCredentialStatus } from "../channels/account-snapshot-fields.js";
import { isChannelVisibleInConfiguredLists } from "../channels/plugins/exposure.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import {
  projectChannelAccountDisplayState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
} from "../channels/status/account-state.js";
import type { AgentBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listExplicitConfiguredChannelIdsForConfig } from "../plugins/channel-plugin-ids.js";
import { resolveMissingOfficialExternalChannelPluginRepairHints } from "../plugins/official-external-plugin-repair-hints.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

type ProviderAccountStatus = {
  provider: ChannelId;
  providerLabel?: string;
  accountId: string;
  name?: string;
  state: ReturnType<typeof projectChannelAccountDisplayState> | "configured unavailable";
  enabled?: boolean;
  configured?: boolean;
  visibleInConfiguredLists?: boolean;
};

type ProviderSummaryMetadata = {
  label: string;
  defaultAccountId: string;
  visibleInConfiguredLists: boolean;
  repairHint?: string;
};

// Concrete account keys normalize aliases; scope keys must keep "*" distinct from "default".
function providerAccountKey(provider: ChannelId, accountId?: string) {
  return `${provider}:${normalizeAccountId(accountId)}`;
}

function recordProviderAccountStatus(
  index: Map<string, ProviderAccountStatus>,
  entry: ProviderAccountStatus,
) {
  const key = providerAccountKey(entry.provider, entry.accountId);
  // Exact canonical spelling wins; otherwise keep the first listed alias.
  if (!index.has(key) || entry.accountId === normalizeAccountId(entry.accountId)) {
    index.set(key, entry);
  }
}

function resolveProviderChannelId(
  rawChannelId: string,
  metadataByProvider: ReadonlyMap<ChannelId, ProviderSummaryMetadata>,
): ChannelId | null {
  const resolved = normalizeChannelId(rawChannelId);
  if (resolved) {
    return resolved;
  }
  const fallback = normalizeOptionalLowercaseString(rawChannelId);
  return fallback && metadataByProvider.has(fallback) ? fallback : null;
}

export function buildProviderSummaryMetadataIndex(
  cfg: OpenClawConfig,
): Map<ChannelId, ProviderSummaryMetadata> {
  const metadata = new Map<ChannelId, ProviderSummaryMetadata>(
    listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: false,
    }).map((plugin) => [
      plugin.id,
      {
        label: plugin.meta.label,
        defaultAccountId: resolveChannelDefaultAccountId({
          plugin,
          cfg,
          accountIds: plugin.config.listAccountIds(cfg),
        }),
        visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta),
      },
    ]),
  );
  const missingChannelIds = listExplicitConfiguredChannelIdsForConfig(cfg).filter(
    (channelId) => !metadata.has(channelId),
  );
  const missingHints = resolveMissingOfficialExternalChannelPluginRepairHints({
    config: cfg,
    channelIds: missingChannelIds,
  });
  for (const hint of missingHints) {
    metadata.set(hint.channelId, {
      label: hint.label,
      defaultAccountId: DEFAULT_ACCOUNT_ID,
      visibleInConfiguredLists: true,
      repairHint: hint.repairHint,
    });
  }
  return metadata;
}

function formatChannelAccountLabel(
  params: Pick<ProviderAccountStatus, "provider" | "providerLabel" | "accountId" | "name">,
): string {
  const label = params.providerLabel ?? params.provider;
  const account = params.name?.trim()
    ? `${params.accountId} (${params.name.trim()})`
    : params.accountId;
  return `${label} ${account}`;
}

export async function buildProviderStatusIndex(
  cfg: OpenClawConfig,
): Promise<Map<string, ProviderAccountStatus>> {
  const map = new Map<string, ProviderAccountStatus>();

  for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  })) {
    const accountIds = plugin.config.listAccountIds(cfg);
    for (const accountId of accountIds) {
      let account: unknown;
      try {
        account = plugin.config.inspectAccount
          ? await plugin.config.inspectAccount(cfg, accountId)
          : await resolveChannelAccount({ plugin, cfg, accountId });
      } catch (error) {
        if (!(error instanceof Error) || !/unresolved SecretRef/i.test(error.message)) {
          throw error;
        }
        recordProviderAccountStatus(map, {
          provider: plugin.id,
          providerLabel: plugin.meta.label,
          accountId,
          state: "configured unavailable",
          configured: true,
          visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta),
        });
        continue;
      }
      if (!account) {
        continue;
      }
      const snapshot = plugin.config.describeAccount?.(account, cfg);
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : typeof snapshot?.enabled === "boolean"
          ? snapshot.enabled
          : (account as { enabled?: boolean }).enabled;
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, cfg)
        : snapshot?.configured;
      const resolvedEnabled = typeof enabled === "boolean" ? enabled : true;
      const resolvedConfigured = typeof configured === "boolean" ? configured : true;
      const inspectedConfigured = (account as { configured?: unknown }).configured;
      const configuredIntent =
        typeof inspectedConfigured === "boolean"
          ? inspectedConfigured
          : snapshot?.configured === true;
      // Provider inspection owns which credentials are required. Only an account whose owner
      // reports complete configured intent but no usable runtime credentials is unavailable.
      const configuredUnavailable =
        !resolvedConfigured &&
        configuredIntent &&
        (hasConfiguredUnavailableCredentialStatus(snapshot) ||
          hasConfiguredUnavailableCredentialStatus(account));
      const linkState =
        resolvedConfigured && plugin.config.isLinked
          ? await plugin.config.isLinked(account, cfg)
          : undefined;
      const linked = resolveChannelAccountLinked(linkState, snapshot?.linked);
      const fallbackState = plugin.status?.resolveAccountState?.({
        account,
        cfg,
        configured: resolvedConfigured,
        enabled: resolvedEnabled,
      });
      const state = configuredUnavailable
        ? "configured unavailable"
        : projectChannelAccountDisplayState(
            resolveChannelAccountState({
              enabled: resolvedEnabled,
              configured: resolvedConfigured,
              linked,
            }),
            fallbackState,
          );
      const name = snapshot?.name ?? (account as { name?: string }).name;
      recordProviderAccountStatus(map, {
        provider: plugin.id,
        providerLabel: plugin.meta.label,
        accountId,
        name,
        state,
        enabled,
        configured: configuredUnavailable || configured,
        visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta),
      });
    }
  }

  return map;
}

function resolveBindingAccountId(binding: AgentBinding): string {
  const accountId = binding.match.accountId?.trim();
  return accountId === "*" ? accountId : normalizeAccountId(accountId);
}

function formatProviderEntry(entry: ProviderAccountStatus): string {
  return `${formatChannelAccountLabel(entry)}: ${entry.state}${entry.enabled === false && entry.state !== "disabled" ? ", disabled" : ""}`;
}

function formatMissingProviderEntry(params: {
  provider: ChannelId;
  accountId: string;
  metadata?: ProviderSummaryMetadata;
}): string {
  const label = formatChannelAccountLabel({
    provider: params.provider,
    providerLabel: params.metadata?.label,
    accountId: params.accountId,
  });
  if (params.metadata?.repairHint) {
    return `${label}: missing plugin - ${params.metadata.repairHint}`;
  }
  return `${label}: unknown`;
}

export function summarizeBindings(
  cfg: OpenClawConfig,
  bindings: AgentBinding[],
  metadataByProvider = buildProviderSummaryMetadataIndex(cfg),
): string[] {
  const seen = new Map<string, string>();
  for (const binding of bindings) {
    const channel = resolveProviderChannelId(binding.match.channel, metadataByProvider);
    if (!channel) {
      continue;
    }
    const accountId = resolveBindingAccountId(binding);
    const key = `${channel}:${accountId}`;
    if (!seen.has(key)) {
      const label = formatChannelAccountLabel({
        provider: channel,
        providerLabel: metadataByProvider.get(channel)?.label,
        accountId,
      });
      seen.set(key, label);
    }
  }
  return [...seen.values()];
}

export function listProvidersForAgent(params: {
  summaryIsDefault: boolean;
  cfg: OpenClawConfig;
  bindings: AgentBinding[];
  providerStatus: Map<string, ProviderAccountStatus>;
  providerMetadata?: ReadonlyMap<ChannelId, ProviderSummaryMetadata>;
}): string[] {
  let allProviderEntries: ProviderAccountStatus[] | undefined;
  const metadataByProvider =
    params.providerMetadata ?? buildProviderSummaryMetadataIndex(params.cfg);
  if (params.bindings.length > 0) {
    // Keep first-seen account order; empty wildcard scopes retain the existing diagnostic.
    const linesByAccount = new Map<string, string>();
    for (const binding of params.bindings) {
      const channel = resolveProviderChannelId(binding.match.channel, metadataByProvider);
      if (!channel) {
        continue;
      }
      const accountId = resolveBindingAccountId(binding);
      const statuses =
        accountId === "*"
          ? (allProviderEntries ??= [...params.providerStatus.values()]).filter(
              (entry) => entry.provider === channel,
            )
          : [params.providerStatus.get(providerAccountKey(channel, accountId))];
      for (const status of statuses.length > 0 ? statuses : [undefined]) {
        linesByAccount.set(
          status ? providerAccountKey(channel, status.accountId) : `${channel}:${accountId}`,
          status
            ? formatProviderEntry(status)
            : formatMissingProviderEntry({
                provider: channel,
                accountId,
                metadata: metadataByProvider.get(channel),
              }),
        );
      }
    }
    return [...linesByAccount.values()];
  }

  const providerLines: string[] = [];
  if (params.summaryIsDefault) {
    const seenProviders = new Set<ChannelId>();
    for (const entry of params.providerStatus.values()) {
      const visibleInConfiguredLists =
        entry.visibleInConfiguredLists ??
        metadataByProvider.get(entry.provider)?.visibleInConfiguredLists;
      if (
        entry.configured ||
        (visibleInConfiguredLists === false &&
          (params.cfg as Record<string, unknown>)[entry.provider])
      ) {
        providerLines.push(formatProviderEntry(entry));
        seenProviders.add(entry.provider);
      }
    }
    for (const [provider, metadata] of metadataByProvider.entries()) {
      if (!metadata.repairHint || seenProviders.has(provider)) {
        continue;
      }
      providerLines.push(
        formatMissingProviderEntry({
          provider,
          accountId: metadata.defaultAccountId,
          metadata,
        }),
      );
    }
  }

  return providerLines;
}
