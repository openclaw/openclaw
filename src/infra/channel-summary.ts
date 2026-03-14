import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
  projectSafeChannelAccountSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "../channels/account-snapshot-fields.js";
import {
  buildChannelAccountSnapshot,
  formatChannelAllowFrom,
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../channels/account-summary.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.js";
import { CHAT_CHANNEL_ORDER, getChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { theme } from "../terminal/theme.js";
import {
  buildFallbackConventionDetails,
  resolveFallbackConventionConfigured,
} from "./channel-summary-fallback-conventions.js";
import { formatTimeAgo } from "./format-time/format-relative.ts";

export type ChannelSummaryOptions = {
  colorize?: boolean;
  includeAllowFrom?: boolean;
  sourceConfig?: OpenClawConfig;
};

const DEFAULT_OPTIONS: Omit<Required<ChannelSummaryOptions>, "sourceConfig"> = {
  colorize: false,
  includeAllowFrom: false,
};

type ChannelAccountEntry = {
  accountId: string;
  account: unknown;
  enabled: boolean;
  configured: boolean;
  snapshot: ChannelAccountSnapshot;
};

const RESERVED_CHANNEL_KEYS = new Set(["defaults", "modelByChannel"]);

function findExtensionsRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, "extensions");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

const FALLBACK_EXTENSION_ROOT =
  findExtensionsRoot(process.cwd()) ??
  findExtensionsRoot(path.dirname(fileURLToPath(import.meta.url))) ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "extensions");
const FALLBACK_EXTENSION_META_CACHE = new Map<string, { label?: string; order?: number } | null>();
const FALLBACK_ACCOUNT_IGNORED_KEYS = new Set([
  "enabled",
  "name",
  "accounts",
  "defaultAccount",
  "allowFrom",
  "dmPolicy",
  "groupPolicy",
  "replyToMode",
  "replyToModeByChatType",
  "channels",
  "groups",
  "guilds",
  "workspaces",
  "heartbeat",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

const formatAccountLabel = (params: { accountId: string; name?: string }) => {
  const base = params.accountId || DEFAULT_ACCOUNT_ID;
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
};

const accountLine = (label: string, details: string[]) =>
  `  - ${label}${details.length ? ` (${details.join(", ")})` : ""}`;

const buildCommonAccountDetails = (params: {
  entry: ChannelAccountEntry;
  allowFromValues?: string[];
}): string[] => {
  const details: string[] = [];
  const snapshot = params.entry.snapshot;
  if (snapshot.enabled === false) {
    details.push("disabled");
  }
  if (snapshot.dmPolicy) {
    details.push(`dm:${snapshot.dmPolicy}`);
  }
  if (snapshot.tokenSource && snapshot.tokenSource !== "none") {
    details.push(`token:${snapshot.tokenSource}`);
  }
  if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") {
    details.push(`bot:${snapshot.botTokenSource}`);
  }
  if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") {
    details.push(`app:${snapshot.appTokenSource}`);
  }
  if (
    snapshot.signingSecretSource &&
    snapshot.signingSecretSource !== "none" /* pragma: allowlist secret */
  ) {
    details.push(`signing:${snapshot.signingSecretSource}`);
  }
  if (hasConfiguredUnavailableCredentialStatus(params.entry.account)) {
    details.push("secret unavailable in this command path");
  }
  if (snapshot.baseUrl) {
    details.push(snapshot.baseUrl);
  }
  if (snapshot.port != null) {
    details.push(`port:${snapshot.port}`);
  }
  if (snapshot.cliPath) {
    details.push(`cli:${snapshot.cliPath}`);
  }
  if (snapshot.dbPath) {
    details.push(`db:${snapshot.dbPath}`);
  }
  if (params.allowFromValues && params.allowFromValues.length > 0) {
    details.push(`allow:${params.allowFromValues.join(",")}`);
  }
  return details;
};

const buildAccountDetails = (params: {
  entry: ChannelAccountEntry;
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  includeAllowFrom: boolean;
}): string[] => {
  const allowFromValues =
    params.includeAllowFrom && params.entry.snapshot.allowFrom?.length
      ? formatChannelAllowFrom({
          plugin: params.plugin,
          cfg: params.cfg,
          accountId: params.entry.snapshot.accountId,
          allowFrom: params.entry.snapshot.allowFrom,
        }).slice(0, 2)
      : [];
  return buildCommonAccountDetails({
    entry: params.entry,
    allowFromValues,
  });
};

function inspectChannelAccount(plugin: ChannelPlugin, cfg: OpenClawConfig, accountId: string) {
  return (
    plugin.config.inspectAccount?.(cfg, accountId) ??
    inspectReadOnlyChannelAccount({
      channelId: plugin.id,
      cfg,
      accountId,
    })
  );
}

function readFallbackExtensionMeta(channelId: string): { label?: string; order?: number } | null {
  if (FALLBACK_EXTENSION_META_CACHE.has(channelId)) {
    return FALLBACK_EXTENSION_META_CACHE.get(channelId) ?? null;
  }

  const packagePath = path.join(FALLBACK_EXTENSION_ROOT, channelId, "package.json");
  if (!fs.existsSync(packagePath)) {
    FALLBACK_EXTENSION_META_CACHE.set(channelId, null);
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      openclaw?: {
        channel?: {
          id?: string;
          label?: string;
          order?: number;
        };
      };
    };
    const channelMeta = raw.openclaw?.channel;
    if (channelMeta?.id && channelMeta.id !== channelId) {
      FALLBACK_EXTENSION_META_CACHE.set(channelId, null);
      return null;
    }
    const meta = {
      label: typeof channelMeta?.label === "string" ? channelMeta.label.trim() || undefined : undefined,
      order: typeof channelMeta?.order === "number" ? channelMeta.order : undefined,
    };
    FALLBACK_EXTENSION_META_CACHE.set(channelId, meta);
    return meta;
  } catch {
    FALLBACK_EXTENSION_META_CACHE.set(channelId, null);
    return null;
  }
}

function compareFallbackExtensionIds(left: string, right: string): number {
  const leftMeta = readFallbackExtensionMeta(left);
  const rightMeta = readFallbackExtensionMeta(right);
  const leftOrder = leftMeta?.order ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = rightMeta?.order ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  const leftLabel = leftMeta?.label ?? left;
  const rightLabel = rightMeta?.label ?? right;
  return leftLabel.localeCompare(rightLabel);
}

function listFallbackChannelIds(cfg: OpenClawConfig): string[] {
  const channels = asRecord(cfg.channels);
  if (!channels) {
    return [];
  }

  const configuredIds = Object.keys(channels).filter((key) => !RESERVED_CHANNEL_KEYS.has(key));
  const configuredSet = new Set(configuredIds);
  const orderedKnown = CHAT_CHANNEL_ORDER.filter((id) => configuredSet.has(id));
  const remaining = configuredIds
    .filter((id) => !orderedKnown.includes(id as (typeof CHAT_CHANNEL_ORDER)[number]))
    .sort(compareFallbackExtensionIds);
  return [...orderedKnown, ...remaining];
}

function formatFallbackChannelLabel(channelId: string): string {
  const normalizedId = normalizeChatChannelId(channelId);
  if (normalizedId) {
    return getChatChannelMeta(normalizedId).label;
  }
  const extensionMeta = readFallbackExtensionMeta(channelId);
  if (extensionMeta?.label) {
    return extensionMeta.label;
  }
  return channelId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function resolveFallbackDefaultAccountId(channelConfig: Record<string, unknown> | null): string {
  const defaultAccount =
    typeof channelConfig?.defaultAccount === "string" ? channelConfig.defaultAccount.trim() : "";
  return defaultAccount || DEFAULT_ACCOUNT_ID;
}

function resolveFallbackAccountIds(channelConfig: Record<string, unknown> | null): string[] {
  const defaultAccountId = resolveFallbackDefaultAccountId(channelConfig);
  const accounts = asRecord(channelConfig?.accounts);
  const accountIds = accounts ? Object.keys(accounts) : [];
  return accountIds.length > 0 ? accountIds : [defaultAccountId];
}

function resolveFallbackAccountConfig(
  channelConfig: Record<string, unknown> | null,
  accountId: string,
): Record<string, unknown> {
  const accounts = asRecord(channelConfig?.accounts);
  const accountRecord = asRecord(accounts?.[accountId]);
  const merged: Record<string, unknown> = {};

  if (channelConfig) {
    for (const [key, value] of Object.entries(channelConfig)) {
      if (FALLBACK_ACCOUNT_IGNORED_KEYS.has(key)) {
        continue;
      }
      merged[key] = value;
    }
  }

  if (accountRecord) {
    for (const [key, value] of Object.entries(accountRecord)) {
      merged[key] = value;
    }
  }

  return merged;
}

function resolveFallbackConfigured(channelId: string, account: unknown): boolean {
  const accountRecord = asRecord(account);
  if (!accountRecord) {
    return false;
  }

  if (typeof accountRecord.configured === "boolean") {
    return accountRecord.configured;
  }

  const conventionConfigured = resolveFallbackConventionConfigured(channelId, accountRecord);
  if (typeof conventionConfigured === "boolean") {
    return conventionConfigured;
  }

  const configuredFromCredentials = resolveConfiguredFromCredentialStatuses(accountRecord);
  if (typeof configuredFromCredentials === "boolean") {
    return configuredFromCredentials;
  }

  if (hasResolvedCredentialValue(accountRecord)) {
    return true;
  }

  return Object.keys(accountRecord).some((key) => {
    if (FALLBACK_ACCOUNT_IGNORED_KEYS.has(key)) {
      return false;
    }
    const value = accountRecord[key];
    if (value == null) {
      return false;
    }
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === "object") {
      return Object.keys(asRecord(value) ?? {}).length > 0;
    }
    return true;
  });
}

function buildFallbackExtensionDetails(channelId: string, account: unknown): string[] {
  return buildFallbackConventionDetails(channelId, account);
}

function buildFallbackAccountDetails(params: {
  channelId: string;
  entry: ChannelAccountEntry;
  includeAllowFrom: boolean;
}): string[] {
  const details = buildCommonAccountDetails({
    entry: params.entry,
    allowFromValues:
      params.includeAllowFrom && params.entry.snapshot.allowFrom?.length
        ? params.entry.snapshot.allowFrom.slice(0, 2)
        : [],
  });
  return [...buildFallbackExtensionDetails(params.channelId, params.entry.account), ...details];
}

function resolveFallbackEnabled(account: unknown, channelConfig: Record<string, unknown> | null): boolean {
  const accountRecord = asRecord(account);
  if (typeof accountRecord?.enabled === "boolean") {
    return accountRecord.enabled;
  }
  if (typeof channelConfig?.enabled === "boolean") {
    return channelConfig.enabled;
  }
  return true;
}

function selectFallbackAccount(params: {
  channelId: string;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  accountId: string;
}): ChannelAccountEntry {
  const resolvedChannelConfig = asRecord(params.cfg.channels?.[params.channelId]);
  const sourceChannelConfig = asRecord(params.sourceConfig.channels?.[params.channelId]);
  const normalizedId = normalizeChatChannelId(params.channelId);
  const resolvedInspected = normalizedId
    ? inspectReadOnlyChannelAccount({
        channelId: normalizedId,
        cfg: params.cfg,
        accountId: params.accountId,
      })
    : null;
  const sourceInspected = normalizedId
    ? inspectReadOnlyChannelAccount({
        channelId: normalizedId,
        cfg: params.sourceConfig,
        accountId: params.accountId,
      })
    : null;
  const resolvedAccount =
    resolvedInspected ?? resolveFallbackAccountConfig(resolvedChannelConfig, params.accountId);
  const sourceAccount = sourceInspected ?? resolveFallbackAccountConfig(sourceChannelConfig, params.accountId);

  const resolvedConfigured = resolveFallbackConfigured(params.channelId, resolvedAccount);
  const sourceConfigured = resolveFallbackConfigured(params.channelId, sourceAccount);
  const useSourceUnavailableAccount = Boolean(
    hasConfiguredUnavailableCredentialStatus(sourceAccount) &&
      (!hasResolvedCredentialValue(resolvedAccount) ||
        (sourceConfigured === true && resolvedConfigured === false)),
  );

  const account = useSourceUnavailableAccount ? sourceAccount : resolvedAccount;
  const configured = useSourceUnavailableAccount ? sourceConfigured : resolvedConfigured;
  const effectiveChannelConfig = useSourceUnavailableAccount ? sourceChannelConfig : resolvedChannelConfig;
  const enabled = resolveFallbackEnabled(account, effectiveChannelConfig);
  const snapshot: ChannelAccountSnapshot = {
    accountId: params.accountId,
    enabled,
    configured,
    ...projectSafeChannelAccountSnapshotFields(account),
  };

  return { accountId: params.accountId, account, snapshot, enabled, configured };
}

async function buildFallbackChannelSummary(params: {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  includeAllowFrom: boolean;
  colorize: boolean;
}): Promise<string[]> {
  const lines: string[] = [];
  const tint = (value: string, color?: (input: string) => string) =>
    params.colorize && color ? color(value) : value;

  for (const channelId of listFallbackChannelIds(params.cfg)) {
    const channelConfig = asRecord(params.cfg.channels?.[channelId]);
    const accountIds = resolveFallbackAccountIds(channelConfig);
    const entries: ChannelAccountEntry[] = accountIds.map((accountId) =>
      selectFallbackAccount({
        channelId,
        cfg: params.cfg,
        sourceConfig: params.sourceConfig,
        accountId,
      }),
    );

    const anyConfigured = entries.some((entry) => entry.configured);
    const anyEnabled = entries.some((entry) => entry.enabled);
    const status = !anyEnabled ? "disabled" : anyConfigured ? "configured" : "not configured";
    const statusColor = status === "configured" ? theme.success : status === "disabled" ? theme.muted : theme.error;
    lines.push(tint(`${formatFallbackChannelLabel(channelId)}: ${status}`, statusColor));

    for (const entry of entries.filter((candidate) => candidate.configured)) {
      const details = buildFallbackAccountDetails({
        channelId,
        entry,
        includeAllowFrom: params.includeAllowFrom,
      });
      lines.push(
        accountLine(
          formatAccountLabel({
            accountId: entry.accountId,
            name: entry.snapshot.name,
          }),
          details,
        ),
      );
    }
  }

  return lines;
}

export async function buildChannelSummary(
  cfg?: OpenClawConfig,
  options?: ChannelSummaryOptions,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const tint = (value: string, color?: (input: string) => string) =>
    resolved.colorize && color ? color(value) : value;
  const sourceConfig = options?.sourceConfig ?? effective;
  const plugins = listChannelPlugins();

  if (plugins.length === 0) {
    return buildFallbackChannelSummary({
      cfg: effective,
      sourceConfig,
      includeAllowFrom: resolved.includeAllowFrom,
      colorize: resolved.colorize,
    });
  }

  for (const plugin of plugins) {
    const accountIds = plugin.config.listAccountIds(effective);
    const defaultAccountId =
      plugin.config.defaultAccountId?.(effective) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];
    const entries: ChannelAccountEntry[] = [];

    for (const accountId of resolvedAccountIds) {
      const sourceInspectedAccount = inspectChannelAccount(plugin, sourceConfig, accountId);
      const resolvedInspectedAccount = inspectChannelAccount(plugin, effective, accountId);
      const resolvedInspection = resolvedInspectedAccount as {
        enabled?: boolean;
        configured?: boolean;
      } | null;
      const sourceInspection = sourceInspectedAccount as {
        enabled?: boolean;
        configured?: boolean;
      } | null;
      const resolvedAccount =
        resolvedInspectedAccount ?? plugin.config.resolveAccount(effective, accountId);
      const useSourceUnavailableAccount = Boolean(
        sourceInspectedAccount &&
        hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
        (!hasResolvedCredentialValue(resolvedAccount) ||
          (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
      );
      const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
      const selectedInspection = useSourceUnavailableAccount
        ? sourceInspection
        : resolvedInspection;
      const enabled =
        selectedInspection?.enabled ??
        resolveChannelAccountEnabled({ plugin, account, cfg: effective });
      const configured =
        selectedInspection?.configured ??
        (await resolveChannelAccountConfigured({
          plugin,
          account,
          cfg: effective,
          readAccountConfiguredField: true,
        }));
      const snapshot = buildChannelAccountSnapshot({
        plugin,
        account,
        cfg: effective,
        accountId,
        enabled,
        configured,
      });
      entries.push({ accountId, account, enabled, configured, snapshot });
    }

    const configuredEntries = entries.filter((entry) => entry.configured);
    const anyEnabled = entries.some((entry) => entry.enabled);
    const fallbackEntry =
      entries.find((entry) => entry.accountId === defaultAccountId) ?? entries[0];
    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account: fallbackEntry?.account ?? {},
          cfg: effective,
          defaultAccountId,
          snapshot:
            fallbackEntry?.snapshot ?? ({ accountId: defaultAccountId } as ChannelAccountSnapshot),
        })
      : undefined;

    const summaryRecord = summary;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    const configured =
      summaryRecord && typeof summaryRecord.configured === "boolean"
        ? summaryRecord.configured
        : configuredEntries.length > 0;

    const status = !anyEnabled
      ? "disabled"
      : linked !== null
        ? linked
          ? "linked"
          : "not linked"
        : configured
          ? "configured"
          : "not configured";

    const statusColor =
      status === "linked" || status === "configured"
        ? theme.success
        : status === "not linked"
          ? theme.error
          : theme.muted;
    const baseLabel = plugin.meta.label ?? plugin.id;
    let line = `${baseLabel}: ${status}`;

    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    const self = summaryRecord?.self as { e164?: string | null } | undefined;
    if (self?.e164) {
      line += ` ${self.e164}`;
    }
    if (authAgeMs != null && authAgeMs >= 0) {
      line += ` auth ${formatTimeAgo(authAgeMs)}`;
    }

    lines.push(tint(line, statusColor));

    if (configuredEntries.length > 0) {
      for (const entry of configuredEntries) {
        const details = buildAccountDetails({
          entry,
          plugin,
          cfg: effective,
          includeAllowFrom: resolved.includeAllowFrom,
        });
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: entry.accountId,
              name: entry.snapshot.name,
            }),
            details,
          ),
        );
      }
    }
  }

  return lines;
}
