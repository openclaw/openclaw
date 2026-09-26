import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveAgentWorkspaceDir, resolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import { listChatChannels } from "../channels/chat-meta.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { listChannelSetupPlugins } from "../channels/plugins/setup-registry.js";
import type {
  ChannelSetupPlugin,
  ChannelSetupStatus,
  ChannelSetupWizardAdapter,
  SetupChannelsOptions,
} from "../channels/plugins/setup-wizard-types.js";
import type { ChannelMeta } from "../channels/plugins/types.core.js";
import { formatChannelPrimerLine, formatChannelSelectionLine } from "../channels/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveChannelSetupEntries,
  shouldShowChannelInSetup,
} from "../commands/channel-setup/discovery.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "../commands/channel-setup/registry.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  findBundledPluginSourceInMap,
  resolveBundledPluginSources,
  type BundledPluginSource,
} from "../plugins/bundled-sources.js";
import { t, wizardT } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { FlowContribution } from "./types.js";

type ChannelStatusSummary = {
  installedPlugins: ChannelSetupPlugin[];
  catalogEntries: ChannelPluginCatalogEntry[];
  installedCatalogEntries: ChannelPluginCatalogEntry[];
  statusByChannel: Map<ChannelChoice, ChannelSetupStatus>;
  statusLines: string[];
};

type ChannelSetupSelectionContribution = FlowContribution & {
  kind: "channel";
  surface: "setup";
  channel: ChannelChoice;
  source: "catalog" | "core" | "plugin";
};

type ChannelSetupSelectionEntry = {
  id: ChannelChoice;
  meta: {
    id: string;
    label: string;
    selectionLabel?: string;
    exposure?: { setup?: boolean };
  };
};

export function resolveChannelSetupWorkspaceDir(cfg: OpenClawConfig): string {
  const agentId = resolveAmbientOwnerAgentId(cfg, undefined, {
    surface: "channel setup",
    hint: "Set agents.defaults.systemAgent.agentId before configuring channels.",
  });
  return resolveAgentWorkspaceDir(cfg, agentId);
}

const CHANNEL_PRIMER_BLURB_KEYS: Record<string, string> = {
  clickclack: "wizard.channelsPrimer.blurbs.clickclack",
  discord: "wizard.channelsPrimer.blurbs.discord",
  feishu: "wizard.channelsPrimer.blurbs.feishu",
  googlechat: "wizard.channelsPrimer.blurbs.googlechat",
  imessage: "wizard.channelsPrimer.blurbs.imessage",
  irc: "wizard.channelsPrimer.blurbs.irc",
  line: "wizard.channelsPrimer.blurbs.line",
  mattermost: "wizard.channelsPrimer.blurbs.mattermost",
  matrix: "wizard.channelsPrimer.blurbs.matrix",
  msteams: "wizard.channelsPrimer.blurbs.msteams",
  "nextcloud-talk": "wizard.channelsPrimer.blurbs.nextcloudTalk",
  nostr: "wizard.channelsPrimer.blurbs.nostr",
  qqbot: "wizard.channelsPrimer.blurbs.qqbot",
  signal: "wizard.channelsPrimer.blurbs.signal",
  slack: "wizard.channelsPrimer.blurbs.slack",
  "synology-chat": "wizard.channelsPrimer.blurbs.synologyChat",
  telegram: "wizard.channelsPrimer.blurbs.telegram",
  tlon: "wizard.channelsPrimer.blurbs.tlon",
  twitch: "wizard.channelsPrimer.blurbs.twitch",
  wecom: "wizard.channelsPrimer.blurbs.wecom",
  whatsapp: "wizard.channelsPrimer.blurbs.whatsapp",
  yuanbao: "wizard.channelsPrimer.blurbs.yuanbao",
  zalo: "wizard.channelsPrimer.blurbs.zalo",
  zalouser: "wizard.channelsPrimer.blurbs.zalouser",
};

function buildChannelSetupSelectionContribution(params: {
  channel: ChannelChoice;
  label: string;
  hint?: string;
  source: "catalog" | "core" | "plugin";
}): ChannelSetupSelectionContribution {
  return {
    id: `channel:setup:${params.channel}`,
    kind: "channel",
    surface: "setup",
    channel: params.channel,
    option: {
      value: params.channel,
      label: params.label,
      ...(params.hint ? { hint: params.hint } : {}),
    },
    source: params.source,
  };
}

function formatSetupSelectionLabel(label: string, fallback: string): string {
  return (
    sanitizeTerminalText(label).trim() ||
    sanitizeTerminalText(fallback).trim() ||
    "<invalid channel>"
  );
}

function formatSetupSelectionHint(hint: string | undefined): string | undefined {
  if (!hint) {
    return undefined;
  }
  return sanitizeTerminalText(hint) || undefined;
}

function formatSetupDisplayText(value: string | undefined, fallback = ""): string {
  return formatSetupSelectionLabel(value ?? "", fallback);
}

function formatSetupFreeText(value: string | undefined): string {
  return sanitizeTerminalText(value ?? "").trim();
}

function formatSetupOptionalDisplayText(value: string | undefined): string | undefined {
  const safe = sanitizeTerminalText(value ?? "").trim();
  return safe || undefined;
}

function formatSetupDisplayList(values: readonly string[] | undefined): string[] | undefined {
  const safe = (values ?? []).flatMap((value) => {
    const sanitized = formatSetupOptionalDisplayText(value);
    return sanitized ? [sanitized] : [];
  });
  return safe.length > 0 ? safe : undefined;
}

function formatSetupDisplayMeta(meta: ChannelMeta): ChannelMeta {
  const { selectionDocsPrefix, ...displayMeta } = meta;
  const safeId = formatSetupDisplayText(meta.id, "<invalid channel>");
  const safeLabel = formatSetupDisplayText(meta.label, safeId);
  const safeSelectionDocsPrefix =
    selectionDocsPrefix === "" ? "" : formatSetupOptionalDisplayText(selectionDocsPrefix?.trim());
  const safeSelectionExtras = formatSetupDisplayList(meta.selectionExtras);
  return {
    ...displayMeta,
    id: safeId,
    label: safeLabel,
    selectionLabel: formatSetupDisplayText(meta.selectionLabel, safeLabel),
    docsPath: formatSetupDisplayText(meta.docsPath, "/"),
    ...(meta.docsLabel ? { docsLabel: formatSetupDisplayText(meta.docsLabel, safeId) } : {}),
    blurb: formatSetupFreeText(meta.blurb),
    ...(safeSelectionDocsPrefix !== undefined
      ? { selectionDocsPrefix: safeSelectionDocsPrefix }
      : {}),
    ...(safeSelectionExtras ? { selectionExtras: safeSelectionExtras } : {}),
  };
}

function formatChannelPrimerBlurb(channel: { id: string; blurb: string }): string {
  const key = CHANNEL_PRIMER_BLURB_KEYS[channel.id];
  if (!key) {
    return channel.blurb;
  }
  const englishBlurb = wizardT(key, undefined, { locale: "en" });
  return channel.blurb === englishBlurb ? t(key) : channel.blurb;
}

function formatChannelSelectionMeta(meta: ChannelMeta): ChannelMeta {
  const formatted = formatSetupDisplayMeta({
    ...meta,
    blurb: formatChannelPrimerBlurb(meta),
  });
  formatted.selectionDocsPrefix ??= t("common.docs");
  return formatted;
}

const CHANNEL_STATUS_LABEL_KEYS: ReadonlyMap<string, string> = new Map([
  ["configured", "wizard.channels.statusConfigured"],
  ["not configured", "wizard.channels.statusNotConfigured"],
  ["configured (plugin disabled)", "wizard.channels.statusConfiguredPluginDisabled"],
  ["installed", "wizard.channels.statusInstalled"],
  ["installed (plugin disabled)", "wizard.channels.statusInstalledPluginDisabled"],
  ["bundled · enable to use", "wizard.channels.statusBundledEnable"],
  ["install plugin to enable", "wizard.channels.statusInstallPluginEnable"],
  ["needs app credentials", "wizard.channels.statusNeedsAppCredentials"],
  ["needs app creds", "wizard.channels.statusNeedsAppCreds"],
  ["needs auth", "wizard.channels.statusNeedsAuth"],
  ["needs host + nick", "wizard.channels.statusNeedsHostNick"],
  ["needs private key", "wizard.channels.statusNeedsPrivateKey"],
  ["needs QR login", "wizard.channels.statusNeedsQrLogin"],
  ["needs service account", "wizard.channels.statusNeedsServiceAccount"],
  ["needs setup", "wizard.channels.statusNeedsSetup"],
  ["needs token", "wizard.channels.statusNeedsToken"],
  ["needs tokens", "wizard.channels.statusNeedsTokens"],
  ["needs token + incoming webhook", "wizard.channels.statusNeedsTokenIncomingWebhook"],
  ["needs token + secret", "wizard.channels.statusNeedsTokenSecret"],
  ["needs token + url", "wizard.channels.statusNeedsTokenUrl"],
  ["needs username, token, and clientId", "wizard.channels.statusNeedsUsernameTokenClientId"],
  ["linked", "wizard.channels.statusLinked"],
  ["logged in", "wizard.channels.statusLoggedIn"],
  ["not linked", "wizard.channels.statusNotLinked"],
  ["recommended · configured", "wizard.channels.statusRecommendedConfigured"],
  ["recommended · logged in", "wizard.channels.statusRecommendedLoggedIn"],
  ["recommended · newcomer-friendly", "wizard.channels.statusRecommendedNewcomerFriendly"],
  ["recommended · QR login", "wizard.channels.statusRecommendedQrLogin"],
  ["self-hosted chat", "wizard.channels.statusSelfHostedChat"],
  ["signal-cli found", "wizard.channels.statusSignalCliFound"],
  ["signal-cli missing", "wizard.channels.statusSignalCliMissing"],
  ["urbit messenger", "wizard.channels.statusUrbitMessenger"],
  ["configured (connection not verified)", "wizard.channels.statusConfiguredConnectionNotVerified"],
]);

function localizeChannelStatusLabel(label: string): string {
  const key = CHANNEL_STATUS_LABEL_KEYS.get(label);
  if (key) {
    return t(key);
  }
  const connectedAsPrefix = "connected as ";
  if (label.startsWith(connectedAsPrefix)) {
    return t("wizard.channels.statusConnectedAs", { name: label.slice(connectedAsPrefix.length) });
  }
  return label;
}

function localizeChannelStatusLine(line: string): string {
  const separator = ": ";
  const index = line.lastIndexOf(separator);
  if (index < 0) {
    return localizeChannelStatusLabel(line);
  }
  return `${line.slice(0, index + separator.length)}${localizeChannelStatusLabel(
    line.slice(index + separator.length),
  )}`;
}

function localizeChannelSetupStatus<T extends { selectionHint?: string; statusLines: string[] }>(
  status: T,
): T {
  return {
    ...status,
    statusLines: status.statusLines.map(localizeChannelStatusLine),
    ...(status.selectionHint
      ? { selectionHint: localizeChannelStatusLabel(status.selectionHint) }
      : {}),
  };
}

// Bundled plugins already ship with the host, so only external sources show download hints.
export function resolveCatalogChannelSelectionHint(
  entry: { install?: { npmSpec?: string } },
  options?: { bundledLocalPath?: string | null },
): string {
  const npmSpec = entry.install?.npmSpec?.trim();
  if (npmSpec && !options?.bundledLocalPath) {
    return `download from ${formatSetupSelectionLabel(npmSpec, npmSpec)}`;
  }
  return "";
}

export function findBundledSourceForCatalogChannel(params: {
  bundled: ReadonlyMap<string, BundledPluginSource>;
  entry: { id: string; pluginId?: string; install?: { npmSpec?: string } };
}): BundledPluginSource | undefined {
  const pluginId = params.entry.pluginId?.trim() || params.entry.id.trim();
  if (pluginId) {
    const byId = findBundledPluginSourceInMap({
      bundled: params.bundled,
      lookup: { kind: "pluginId", value: pluginId },
    });
    if (byId) {
      return byId;
    }
  }
  const npmSpec = params.entry.install?.npmSpec?.trim();
  if (npmSpec) {
    return findBundledPluginSourceInMap({
      bundled: params.bundled,
      lookup: { kind: "npmSpec", value: npmSpec },
    });
  }
  return undefined;
}

export async function collectChannelStatus(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelChoice, string>>;
  installedPlugins?: ChannelSetupPlugin[];
  resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<ChannelStatusSummary> {
  const installedPlugins = params.installedPlugins ?? listChannelSetupPlugins();
  const workspaceDir = params.workspaceDir ?? resolveChannelSetupWorkspaceDir(params.cfg);
  const { installedCatalogEntries, installableCatalogEntries } = resolveChannelSetupEntries({
    cfg: params.cfg,
    installedPlugins,
    workspaceDir,
  });
  const bundledSources = resolveBundledPluginSources({ workspaceDir });
  const resolveAdapter =
    params.resolveAdapter ??
    ((channel: ChannelChoice) =>
      resolveChannelSetupWizardAdapterForPlugin(
        installedPlugins.find((plugin) => plugin.id === channel),
      ));
  const statusEntries = (
    await Promise.all(
      installedPlugins
        .filter((plugin) => shouldShowChannelInSetup(plugin.meta))
        .map(async (plugin): Promise<ChannelSetupStatus | undefined> => {
          try {
            const adapter = resolveAdapter(plugin.id);
            if (!adapter) {
              return undefined;
            }
            return await adapter.getStatus({
              cfg: params.cfg,
              options: params.options,
              accountOverrides: params.accountOverrides,
            });
          } catch (error) {
            const detail = formatSetupFreeText(formatErrorMessage(error));
            return {
              channel: plugin.id,
              configured: isChannelConfigured(params.cfg, plugin.id),
              statusLines: [
                `${formatSetupSelectionLabel(plugin.meta.label, plugin.id)}: status unavailable (${detail})`,
              ],
              selectionHint: "status unavailable",
            };
          }
        }),
    )
  ).filter((status): status is ChannelSetupStatus => status !== undefined);
  const statusByChannel = new Map(
    statusEntries.map((entry: ChannelSetupStatus) => [entry.channel, entry]),
  );
  const fallbackStatuses = listChatChannels()
    .filter((meta) => shouldShowChannelInSetup(meta))
    .filter((meta) => !statusByChannel.has(meta.id))
    .map((meta) => {
      const configured = isChannelConfigured(params.cfg, meta.id);
      const statusLabel = configured ? "configured (plugin disabled)" : "not configured";
      return {
        channel: meta.id,
        configured,
        statusLines: [`${formatSetupSelectionLabel(meta.label, meta.id)}: ${statusLabel}`],
        selectionHint: configured ? "configured · plugin disabled" : "not configured",
        quickstartScore: 0,
      };
    });
  const discoveredPluginStatuses = installedCatalogEntries
    .filter((entry) => !statusByChannel.has(entry.id as ChannelChoice))
    .map((entry) => {
      const configured = isChannelConfigured(params.cfg, entry.id);
      const pluginEnabled =
        params.cfg.plugins?.entries?.[entry.pluginId ?? entry.id]?.enabled !== false;
      const statusLabel = configured
        ? pluginEnabled
          ? "configured"
          : "configured (plugin disabled)"
        : pluginEnabled
          ? "installed"
          : "installed (plugin disabled)";
      return {
        channel: entry.id as ChannelChoice,
        configured,
        statusLines: [`${formatSetupSelectionLabel(entry.meta.label, entry.id)}: ${statusLabel}`],
        selectionHint: statusLabel,
        quickstartScore: 0,
      };
    });
  const catalogStatuses = installableCatalogEntries.map((entry) => {
    const bundledLocalPath =
      findBundledSourceForCatalogChannel({ bundled: bundledSources, entry })?.localPath ?? null;
    const isBundled = Boolean(bundledLocalPath);
    const statusLabel = isBundled ? "bundled · enable to use" : "install plugin to enable";
    return {
      channel: entry.id,
      configured: false,
      statusLines: [`${formatSetupSelectionLabel(entry.meta.label, entry.id)}: ${statusLabel}`],
      selectionHint: resolveCatalogChannelSelectionHint(entry, { bundledLocalPath }),
      quickstartScore: 0,
    };
  });
  const combinedStatuses = [
    ...statusEntries,
    ...fallbackStatuses,
    ...discoveredPluginStatuses,
    ...catalogStatuses,
  ].map(localizeChannelSetupStatus);
  const mergedStatusByChannel = new Map(combinedStatuses.map((entry) => [entry.channel, entry]));
  const statusLines = combinedStatuses.flatMap((entry) => entry.statusLines);
  return {
    installedPlugins,
    catalogEntries: installableCatalogEntries,
    installedCatalogEntries,
    statusByChannel: mergedStatusByChannel,
    statusLines,
  };
}

export async function noteChannelPrimer(
  prompter: WizardPrompter,
  channels: Array<{ id: ChannelChoice; blurb: string; label: string }>,
): Promise<void> {
  const channelLines = channels.map((channel) =>
    formatChannelPrimerLine(
      formatSetupDisplayMeta({
        id: channel.id,
        label: channel.label,
        selectionLabel: channel.label,
        docsPath: "/",
        blurb: formatChannelPrimerBlurb(channel),
      }),
    ),
  );
  await prompter.note(
    [
      t("wizard.channelsPrimer.inboundSafety"),
      t("wizard.channelsPrimer.approveWith", {
        command: formatCliCommand("openclaw pairing approve <channel> <code>"),
      }),
      t("wizard.channelsPrimer.openDm"),
      t("wizard.channelsPrimer.multiUserDm", {
        command: formatCliCommand('openclaw config set session.dmScope "per-channel-peer"'),
      }),
      t("wizard.channelsPrimer.docs", {
        link: formatDocsLink("/channels/pairing", "channels/pairing"),
      }),
      "",
      ...channelLines,
    ].join("\n"),
    t("wizard.channelsPrimer.title"),
  );
}

export function resolveQuickstartDefault(
  statusByChannel: Map<ChannelChoice, { quickstartScore?: number }>,
): ChannelChoice | undefined {
  let best: { channel: ChannelChoice; score: number } | null = null;
  for (const [channel, status] of statusByChannel) {
    if (status.quickstartScore == null) {
      continue;
    }
    if (!best || status.quickstartScore > best.score) {
      best = { channel, score: status.quickstartScore };
    }
  }
  return best?.channel;
}

export function resolveChannelSelectionNoteLines(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  installedPlugins: ChannelSetupPlugin[];
  selection: ChannelChoice[];
}): string[] {
  const { entries } = resolveChannelSetupEntries({
    cfg: params.cfg,
    installedPlugins: params.installedPlugins,
    workspaceDir: params.workspaceDir ?? resolveChannelSetupWorkspaceDir(params.cfg),
  });
  const selectionNotes = new Map<string, string>();
  for (const entry of entries) {
    selectionNotes.set(
      entry.id,
      formatChannelSelectionLine(formatChannelSelectionMeta(entry.meta), formatDocsLink),
    );
  }
  return params.selection
    .map((channel) => selectionNotes.get(channel))
    .filter((line): line is string => Boolean(line));
}

export function resolveChannelSetupSelectionContributions(params: {
  entries: ChannelSetupSelectionEntry[];
  statusByChannel: Map<ChannelChoice, { selectionHint?: string }>;
  resolveDisabledHint: (channel: ChannelChoice) => string | undefined;
}): ChannelSetupSelectionContribution[] {
  const bundledChannelIds = new Set(listChatChannels().map((channel) => channel.id));
  return params.entries
    .filter((entry) => shouldShowChannelInSetup(entry.meta))
    .toSorted((left, right) => compareChannelSetupSelectionEntries(left, right))
    .map((entry) => {
      const disabledHint = params.resolveDisabledHint(entry.id);
      const statusHint = params.statusByChannel.get(entry.id)?.selectionHint;
      const hint = [statusHint, disabledHint].filter(Boolean).join(" · ") || undefined;
      return buildChannelSetupSelectionContribution({
        channel: entry.id,
        label: formatSetupSelectionLabel(entry.meta.selectionLabel ?? entry.meta.label, entry.id),
        hint: formatSetupSelectionHint(hint),
        source: bundledChannelIds.has(entry.id) ? "core" : "plugin",
      });
    });
}

function compareChannelSetupSelectionEntries(
  left: ChannelSetupSelectionEntry,
  right: ChannelSetupSelectionEntry,
): number {
  const leftLabel = left.meta.selectionLabel ?? left.meta.label;
  const rightLabel = right.meta.selectionLabel ?? right.meta.label;
  return (
    leftLabel.localeCompare(rightLabel, undefined, { numeric: true, sensitivity: "base" }) ||
    left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: "base" })
  );
}
