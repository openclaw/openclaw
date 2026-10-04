import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { formatUnknownChannelMessage } from "../../cli/error-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type OfficialExternalPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHints,
} from "../../plugins/official-external-plugin-repair-hints.js";
import { defaultRuntime } from "../../runtime.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { createDedupeCache } from "../dedupe.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import {
  getRuntimeVisibleChannelPlugin,
  listRuntimeVisibleChannelPlugins,
} from "./runtime-visible-channels.js";

/** Source that explains how message channel selection chose its result. */
type MessageChannelSelectionSource = "explicit" | "tool-context-fallback" | "single-configured";

function resolveAvailableChannel(params: {
  cfg: OpenClawConfig;
  value?: string | null;
  agentId?: string;
}): { channel: string; plugin: ChannelPlugin } | undefined {
  // Availability belongs to the scoped resolver, not the process-root channel list.
  const normalized = normalizeMessageChannel(params.value);
  if (!normalized) {
    return undefined;
  }
  // Local agent processes may have only setup metadata for external channels;
  // explicit activation lets their message tools use the same send path as the CLI.
  const plugin = resolveOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  return plugin ? { channel: plugin.id, plugin } : undefined;
}

/** Checks whether a channel has a non-disabled config entry. */
export function isConfiguredChannel(cfg: OpenClawConfig, channelId: string): boolean {
  const entry = asOptionalRecord(asOptionalRecord(cfg.channels)?.[channelId]);
  return entry !== undefined && entry.enabled !== false;
}

function listConfiguredOfficialExternalRepairHints(
  cfg: OpenClawConfig,
): OfficialExternalPluginRepairHint[] {
  const channels = asOptionalRecord(cfg.channels);
  if (!channels) {
    return [];
  }
  return resolveMissingOfficialExternalChannelPluginRepairHints({
    config: cfg,
    channelIds: Object.keys(channels).filter((channelId) => isConfiguredChannel(cfg, channelId)),
  });
}

function formatMissingOfficialExternalChannelsMessage(
  hints: readonly OfficialExternalPluginRepairHint[],
): string {
  const [onlyHint] = hints;
  if (hints.length === 1 && onlyHint) {
    return `Configured official external channel ${onlyHint.label} is missing its plugin. ${onlyHint.repairHint}`;
  }
  const labels = hints.map((hint) => hint.label).join(", ");
  const installCommands = hints.map((hint) => hint.installCommand).join("; ");
  return `Configured official external channels ${labels} are missing their plugins. Run: openclaw doctor --fix, or install individually: ${installCommands}.`;
}

// Bound process-lifetime warning state; evicted plugin/account failures may log again.
const loggedChannelSelectionErrors = createDedupeCache({
  ttlMs: 0,
  maxSize: 1024,
});

function logChannelSelectionError(params: {
  pluginId: string;
  accountId: string;
  operation: "inspectAccount" | "resolveAccount" | "isConfigured";
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.accountId}:${params.operation}:${message}`;
  if (loggedChannelSelectionErrors.check(key)) {
    return;
  }
  defaultRuntime.error?.(
    `[channel-selection] ${params.pluginId}(${params.accountId}) ${params.operation} failed: ${message}`,
  );
}

type AccountResolutionMode = "strict" | "read_only";

async function isPluginConfigured(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
  accountResolution: AccountResolutionMode,
): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  for (const accountId of accountIds) {
    let operation: "inspectAccount" | "resolveAccount" = "inspectAccount";
    let account: unknown;
    try {
      if (accountResolution === "read_only") {
        const inspection = asOptionalRecord(await plugin.config.inspectAccount?.(cfg, accountId));
        if (inspection) {
          // Inspection is metadata, never input to runtime account hooks.
          if (isAccountEnabled(inspection) && inspection.configured === true) {
            return true;
          }
          continue;
        }
      }
      operation = "resolveAccount";
      account = await resolveChannelAccount({ plugin, cfg, accountId });
    } catch (error) {
      logChannelSelectionError({
        pluginId: plugin.id,
        accountId,
        operation,
        error,
      });
      continue;
    }
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) {
      continue;
    }
    try {
      const configured = (await plugin.config.isConfigured?.(account, cfg)) ?? true;
      if (configured) {
        return true;
      }
    } catch (error) {
      logChannelSelectionError({
        pluginId: plugin.id,
        accountId,
        operation: "isConfigured",
        error,
      });
    }
  }

  return false;
}

async function listConfiguredMessageChannelPlugins(
  cfg: OpenClawConfig,
  accountResolution: AccountResolutionMode = "strict",
): Promise<ChannelPlugin[]> {
  const plugins: ChannelPlugin[] = [];
  for (const plugin of listRuntimeVisibleChannelPlugins()) {
    if (!resolveOutboundChannelPlugin({ channel: plugin.id, cfg })) {
      continue;
    }
    if (await isPluginConfigured(plugin, cfg, accountResolution)) {
      plugins.push(plugin);
    }
  }
  return plugins;
}

/** Lists deliverable channels with at least one enabled, configured account. */
export async function listConfiguredMessageChannels(cfg: OpenClawConfig): Promise<string[]> {
  return (await listConfiguredMessageChannelPlugins(cfg)).map((plugin) => plugin.id);
}

/** Resolves the message action channel from explicit input, context fallback, or config. */
export async function resolveMessageChannelSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  fallbackChannel?: string | null;
  agentId?: string;
  // Strict callers select usable runtime accounts. Directory inspection opts in before it knows
  // which account-scoped SecretRefs to redeem.
  accountResolution?: AccountResolutionMode;
}): Promise<{
  channel: string;
  plugin: ChannelPlugin;
  configured: string[];
  source: MessageChannelSelectionSource;
}> {
  const normalized = normalizeMessageChannel(params.channel);
  const explicit = normalized
    ? resolveAvailableChannel({
        cfg: params.cfg,
        value: params.channel,
        agentId: params.agentId,
      })
    : undefined;
  if (explicit) {
    return { ...explicit, configured: [], source: "explicit" };
  }

  const fallback = resolveAvailableChannel({
    cfg: params.cfg,
    value: params.fallbackChannel,
    agentId: params.agentId,
  });
  if (fallback) {
    return {
      ...fallback,
      configured: [],
      source: "tool-context-fallback",
    };
  }

  if (normalized) {
    if (!isDeliverableMessageChannel(normalized) && !getRuntimeVisibleChannelPlugin(normalized)) {
      throw new Error(formatUnknownChannelMessage({ channel: normalized }));
    }
    const repairHint = isConfiguredChannel(params.cfg, normalized)
      ? resolveMissingOfficialExternalChannelPluginRepairHint({
          config: params.cfg,
          channelId: normalized,
        })
      : null;
    if (repairHint?.channelId === normalized) {
      throw new Error(`Channel is unavailable: ${normalized}. ${repairHint.repairHint}`);
    }
    throw new Error(`Channel is unavailable: ${normalized}`);
  }

  const configuredPlugins = await listConfiguredMessageChannelPlugins(
    params.cfg,
    params.accountResolution,
  );
  const configured = configuredPlugins.map((plugin) => plugin.id);
  const [plugin] = configuredPlugins;
  if (configuredPlugins.length === 1 && plugin) {
    return {
      channel: plugin.id,
      plugin,
      configured,
      source: "single-configured",
    };
  }
  if (configured.length === 0) {
    const repairHints = listConfiguredOfficialExternalRepairHints(params.cfg);
    if (repairHints.length > 0) {
      throw new Error(
        `Channel is required (no available channels detected). ${formatMissingOfficialExternalChannelsMessage(repairHints)}`,
      );
    }
    throw new Error(
      "Channel is required (no configured channels detected). " +
        "Run openclaw channels add to configure one, or pass --channel <channel> after enabling a channel. " +
        "Use openclaw channels list --all to see available channel ids.",
    );
  }
  throw new Error(
    `Channel is required when multiple channels are configured: ${configured.join(", ")}. Pass --channel <channel> to choose one.`,
  );
}
