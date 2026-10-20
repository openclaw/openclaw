import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { describeChannelAccount, resolveChannelAccount } from "../channels/account-resolution.js";
import { hasConfiguredUnavailableCredentialStatus } from "../channels/account-snapshot-fields.js";
import { isChannelVisibleInConfiguredLists } from "../channels/plugins/exposure.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import {
  projectChannelAccountDisplayState,
  resolveChannelAccountLinked,
  resolveChannelAccountState,
} from "../channels/status/account-state.js";
import { formatCliCommand } from "../cli/command-format.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentBinding, AgentRouteBinding } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listExplicitConfiguredChannelIdsForConfig } from "../plugins/channel-plugin-ids.js";
import { resolveMissingOfficialExternalChannelPluginRepairHints } from "../plugins/official-external-plugin-repair-hints.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeAgentId,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson, defaultRuntime } from "../runtime.js";
import {
  evaluateAgentDatabaseAdmissions,
  hasAgentDatabaseAdmissions,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  listAgentProvenance,
  readAgentProvenanceForDisplay,
  type AgentProvenance,
} from "../state/agent-provenance.js";
import { shortenHomePath } from "../utils.js";
import { describeBinding } from "./agents.binding-format.js";
import type { AgentSummary } from "./agents.config.js";
import { buildAgentSummaries } from "./agents.config.js";
import { requireValidConfig } from "./config-validation.js";

type AgentsListOptions = {
  json?: boolean;
  bindings?: boolean;
  tree?: boolean;
};

function formatSummaryHeader(summary: AgentSummary): string {
  const safe = sanitizeTerminalText;
  const defaultTag = `${summary.isDefault ? " (default)" : ""}${summary.status === "degraded" ? " (degraded)" : ""}`;
  return summary.name && summary.name !== summary.id
    ? `${safe(summary.id)}${defaultTag} (${safe(summary.name)})`
    : `${safe(summary.id)}${defaultTag}`;
}

function formatSummary(summary: AgentSummary) {
  const safe = sanitizeTerminalText;
  const header = formatSummaryHeader(summary);

  const identityParts = [summary.identityEmoji, summary.identityName]
    .filter((part): part is string => Boolean(part))
    .map(safe);
  const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
  const identitySource =
    summary.identitySource === "identity"
      ? "IDENTITY.md"
      : summary.identitySource === "config"
        ? "config"
        : null;

  const lines = [`- ${header}`];
  if (summary.admissionRefusal) {
    lines.push(`  Refused: ${safe(summary.admissionRefusal.reason)}`);
    lines.push(`  Repair: ${safe(summary.admissionRefusal.repairHint)}`);
  }
  if (identityLine) {
    lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
  }
  lines.push(`  Workspace: ${safe(shortenHomePath(summary.workspace))}`);
  lines.push(`  Agent dir: ${safe(shortenHomePath(summary.agentDir))}`);
  if (summary.model) {
    lines.push(`  Model: ${safe(summary.model)}`);
  }
  lines.push(`  Routing rules: ${summary.bindings}`);

  if (summary.routes?.length) {
    lines.push(`  Routing: ${summary.routes.map(safe).join(", ")}`);
  }
  for (const [heading, entries] of [
    ["  Providers:", summary.providers],
    ["  Routing rules:", summary.bindingDetails],
  ] as const) {
    if (entries?.length) {
      lines.push(heading);
      for (const entry of entries) {
        lines.push(`    - ${safe(entry)}`);
      }
    }
  }
  return lines.join("\n");
}

function formatAgentTree(summaries: AgentSummary[], provenance: AgentProvenance[]): string[] {
  const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
  const provenanceById = new Map(provenance.map((record) => [record.agentId, record]));
  const childrenById = new Map<string, AgentSummary[]>();
  const roots: AgentSummary[] = [];

  for (const summary of summaries) {
    const creatorAgentId = provenanceById.get(summary.id)?.creatorAgentId;
    if (creatorAgentId && creatorAgentId !== summary.id && summaryById.has(creatorAgentId)) {
      const children = childrenById.get(creatorAgentId) ?? [];
      children.push(summary);
      childrenById.set(creatorAgentId, children);
    } else {
      roots.push(summary);
    }
  }

  const lines: string[] = [];
  const visited = new Set<string>();
  const append = (summary: AgentSummary, depth: number): void => {
    if (visited.has(summary.id)) {
      return;
    }
    visited.add(summary.id);
    lines.push(`${"  ".repeat(depth)}- ${formatSummaryHeader(summary)}`);
    for (const child of childrenById.get(summary.id) ?? []) {
      append(child, depth + 1);
    }
  };
  roots.forEach((summary) => append(summary, 0));
  // Corrupt or manually rewritten provenance can form a cycle. Keep every
  // configured agent visible by promoting the first unseen member to a root.
  summaries.forEach((summary) => append(summary, 0));
  return lines;
}

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

function formatChannelAccountLabel(
  params: Pick<ProviderAccountStatus, "provider" | "providerLabel" | "accountId" | "name">,
): string {
  const label = params.providerLabel ?? params.provider;
  const account = params.name?.trim()
    ? `${params.accountId} (${params.name.trim()})`
    : params.accountId;
  return `${label} ${account}`;
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

async function enrichProviderSummaries(
  cfg: OpenClawConfig,
  summaries: AgentSummary[],
  bindingMap: ReadonlyMap<string, AgentRouteBinding[]>,
) {
  const inventory = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  }).map((plugin) => ({ plugin, accountIds: plugin.config.listAccountIds(cfg) }));
  const providerStatus = new Map<string, ProviderAccountStatus>();

  for (const { plugin, accountIds } of inventory) {
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
        recordProviderAccountStatus(providerStatus, {
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
      const snapshot = await describeChannelAccount({ plugin, account, cfg });
      const enabled = plugin.config.isEnabled
        ? plugin.config.isEnabled(account, cfg)
        : typeof snapshot?.enabled === "boolean"
          ? snapshot.enabled
          : (account as { enabled?: boolean }).enabled; // SAFETY: Plugin-owned optional enabled field.
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, cfg)
        : snapshot?.configured;
      const resolvedEnabled = typeof enabled === "boolean" ? enabled : true;
      const resolvedConfigured = typeof configured === "boolean" ? configured : true;
      // SAFETY: Read the plugin-owned optional field as unknown before the boolean check below.
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
      // SAFETY: Plugin account names share the optional display-name contract of its snapshot.
      const name = snapshot?.name ?? (account as { name?: string }).name;
      recordProviderAccountStatus(providerStatus, {
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

  const metadataByProvider = new Map<ChannelId, ProviderSummaryMetadata>(
    inventory.map(({ plugin }) => [
      plugin.id,
      {
        label: plugin.meta.label,
        visibleInConfiguredLists: isChannelVisibleInConfiguredLists(plugin.meta),
      },
    ]),
  );
  const missingChannelIds = listExplicitConfiguredChannelIdsForConfig(cfg).filter(
    (channelId) => !metadataByProvider.has(channelId),
  );
  const missingHints = resolveMissingOfficialExternalChannelPluginRepairHints({
    config: cfg,
    channelIds: missingChannelIds,
  });
  for (const hint of missingHints) {
    metadataByProvider.set(hint.channelId, {
      label: hint.label,
      visibleInConfiguredLists: true,
      repairHint: hint.repairHint,
    });
  }
  let allProviderEntries: ProviderAccountStatus[] | undefined;
  for (const summary of summaries) {
    const bindings = bindingMap.get(summary.id) ?? [];
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
    const routes = [...seen.values()];
    if (routes.length > 0) {
      summary.routes = routes;
    } else if (summary.isDefault) {
      summary.routes = ["default (no explicit rules)"];
    }
    const providerLines: string[] = [];
    if (bindings.length > 0) {
      // Keep first-seen account order; empty wildcard scopes retain the existing diagnostic.
      const linesByAccount = new Map<string, string>();
      for (const binding of bindings) {
        const channel = resolveProviderChannelId(binding.match.channel, metadataByProvider);
        if (!channel) {
          continue;
        }
        const accountId = resolveBindingAccountId(binding);
        const statuses =
          accountId === "*"
            ? (allProviderEntries ??= [...providerStatus.values()]).filter(
                (entry) => entry.provider === channel,
              )
            : [providerStatus.get(providerAccountKey(channel, accountId))];
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
      providerLines.push(...linesByAccount.values());
    } else if (summary.isDefault) {
      const seenProviders = new Set<ChannelId>();
      for (const entry of providerStatus.values()) {
        const visibleInConfiguredLists =
          entry.visibleInConfiguredLists ??
          metadataByProvider.get(entry.provider)?.visibleInConfiguredLists;
        if (
          entry.configured ||
          // SAFETY: Config is an object; legacy plugin keys are only tested for presence here.
          (visibleInConfiguredLists === false && (cfg as Record<string, unknown>)[entry.provider])
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
            accountId: DEFAULT_ACCOUNT_ID,
            metadata,
          }),
        );
      }
    }
    if (providerLines.length > 0) {
      summary.providers = providerLines;
    }
  }
}

export async function agentsListCommand(
  opts: AgentsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime, { adoptPluginMetadata: true });
  if (!cfg) {
    return;
  }

  if (!hasAgentDatabaseAdmissions()) {
    recordAgentDatabaseAdmissions(await evaluateAgentDatabaseAdmissions(cfg));
  }
  const summaries = await buildAgentSummaries(cfg);
  const provenance = opts.tree ? await listAgentProvenance() : [];
  if (opts.json) {
    const records = await readAgentProvenanceForDisplay(summaries.map((summary) => summary.id));
    const recordsById = new Map(records.map((record) => [record.agentId, record]));
    for (const summary of summaries) {
      const record = recordsById.get(summary.id);
      if (record) {
        summary.createdVia = record.createdVia;
        summary.creatorAgentId = record.creatorAgentId;
        summary.createdAt = record.createdAtMs;
      }
    }
  }
  const bindingMap = new Map<string, AgentRouteBinding[]>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    const list = bindingMap.get(agentId) ?? [];
    list.push(binding);
    bindingMap.set(agentId, list);
  }

  if (opts.bindings) {
    for (const summary of summaries) {
      const bindings = bindingMap.get(summary.id) ?? [];
      if (bindings.length > 0) {
        summary.bindingDetails = bindings.map(describeBinding);
      }
    }
  }

  // JSON and tree queries avoid plugin runtime unless --bindings requests provider enrichment.
  const includeProviderDetails = (!opts.json && !opts.tree) || opts.bindings === true;
  if (includeProviderDetails) {
    await enrichProviderSummaries(cfg, summaries, bindingMap);
  }

  if (opts.json) {
    writeRuntimeJson(runtime, summaries);
    return;
  }

  if (opts.tree) {
    runtime.log(["Agents:", ...formatAgentTree(summaries, provenance)].join("\n"));
    return;
  }

  const lines = ["Agents:", ...summaries.map(formatSummary)];
  lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
  lines.push(
    `Channel status reflects local config/creds. For live health: ${formatCliCommand("openclaw channels status --probe")}.`,
  );
  runtime.log(lines.join("\n"));
}
