import { resolveExplicitConfigWriteTarget } from "../../channels/plugins/config-writes.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import {
  getConfigValueAtPath,
  setConfigValueAtPath,
  unsetConfigValueAtPath,
} from "../../config/config-paths.js";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  validateConfigObjectWithPlugins,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveInboundDebounceMs } from "../inbound-debounce.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScopeForInternalChannel,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";
import { parseMessagingWindowCommand } from "./messaging-window-command.js";

const GLOBAL_PATH = ["messages", "inbound", "debounceMs"];
const CHANNEL_PATH_PREFIX = ["messages", "inbound", "byChannel"];

function formatMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "unset";
  }
  const normalized = Math.max(0, Math.round(ms));
  if (normalized === 0) {
    return "off";
  }
  if (normalized % 1000 === 0) {
    return `${normalized / 1000}s`;
  }
  return `${normalized}ms`;
}

function resolveCurrentChannel(params: Parameters<CommandHandler>[0], raw: string): string | null {
  if (raw === "current" || raw === "this") {
    return resolveOriginChannelId(params);
  }
  return normalizeAnyChannelId(raw) ?? normalizeChannelId(raw) ?? normalizeSafeChannelId(raw);
}

function resolveOriginChannelId(params: Parameters<CommandHandler>[0]): string | null {
  return (
    params.command.channelId ??
    normalizeAnyChannelId(params.command.channel) ??
    normalizeChannelId(params.command.channel) ??
    normalizeSafeChannelId(params.command.channel)
  );
}

function normalizeSafeChannelId(raw: string): string | null {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized || normalized.length > 80) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function buildStatusText(cfg: OpenClawConfig, channel: string): string {
  const globalValue = getConfigValueAtPath(cfg as Record<string, unknown>, GLOBAL_PATH);
  const channelValue = getConfigValueAtPath(cfg as Record<string, unknown>, [
    ...CHANNEL_PATH_PREFIX,
    channel,
  ]);
  const effective = resolveInboundDebounceMs({ cfg, channel });
  return [
    "Messaging window:",
    `global: ${formatMs(typeof globalValue === "number" ? globalValue : undefined)}`,
    `${channel}: ${formatMs(typeof channelValue === "number" ? channelValue : undefined)}`,
    `effective for ${channel}: ${formatMs(effective)}`,
    "",
    "Set from chat:",
    "/messaging_window 3s",
    `/messaging_window ${channel} 5s`,
    "/messaging_window current 5s",
    "/messaging_window off",
    "/messaging_window current off",
  ].join("\n");
}

function cloneParsedConfig(parsed: object): Record<string, unknown> {
  return structuredClone(parsed) as Record<string, unknown>;
}

async function loadEditableConfig(): Promise<
  { ok: true; config: Record<string, unknown> } | { ok: false; text: string }
> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
    return {
      ok: false,
      text: "Config file is invalid; fix it before using /messaging_window.",
    };
  }
  return { ok: true, config: cloneParsedConfig(snapshot.parsed) };
}

export const handleMessagingWindowCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const command = parseMessagingWindowCommand(params.command.commandBodyNormalized);
  if (!command) {
    return null;
  }

  const unauthorized = rejectUnauthorizedCommand(params, "/messaging_window");
  if (unauthorized) {
    return unauthorized;
  }

  const currentChannel = resolveOriginChannelId(params) ?? params.command.channel;

  if (command.action === "status") {
    const loaded = await loadEditableConfig();
    if (!loaded.ok) {
      return { shouldContinue: false, reply: { text: loaded.text } };
    }
    return {
      shouldContinue: false,
      reply: { text: buildStatusText(loaded.config as OpenClawConfig, currentChannel) },
    };
  }
  if (command.action === "error") {
    return { shouldContinue: false, reply: { text: command.message } };
  }

  const nonOwner = rejectNonOwnerCommand(params, "/messaging_window");
  if (nonOwner) {
    return nonOwner;
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/messaging_window",
    configKey: "config",
  });
  if (disabled) {
    return disabled;
  }

  const missingAdminScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/messaging_window",
    allowedScopes: ["operator.admin"],
    missingText: "/messaging_window requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  const channel =
    command.scope === "channel" ? resolveCurrentChannel(params, command.channel) : undefined;
  if (command.scope === "channel" && !channel) {
    return {
      shouldContinue: false,
      reply: { text: `Unknown channel: ${command.channel}` },
    };
  }

  const path = command.scope === "global" ? GLOBAL_PATH : [...CHANNEL_PATH_PREFIX, channel ?? ""];
  const configWriteTarget =
    command.scope === "global"
      ? ({ kind: "global" } as const)
      : resolveExplicitConfigWriteTarget({ channelId: channel });
  const deniedText = resolveConfigWriteDeniedText({
    cfg: params.cfg,
    channel: params.command.channel,
    channelId: resolveOriginChannelId(params),
    accountId: resolveChannelAccountId({
      cfg: params.cfg,
      ctx: params.ctx,
      command: params.command,
    }),
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    target: configWriteTarget,
  });
  if (deniedText) {
    return { shouldContinue: false, reply: { text: deniedText } };
  }

  const loaded = await loadEditableConfig();
  if (!loaded.ok) {
    return { shouldContinue: false, reply: { text: loaded.text } };
  }

  if (command.action === "reset") {
    const removed = unsetConfigValueAtPath(loaded.config, path);
    if (!removed) {
      const target = command.scope === "global" ? "global" : channel;
      return {
        shouldContinue: false,
        reply: { text: `Messaging window for ${target} was already unset.` },
      };
    }
  } else {
    setConfigValueAtPath(loaded.config, path, command.debounceMs);
  }

  const validated = validateConfigObjectWithPlugins(loaded.config);
  if (!validated.ok) {
    const issue = validated.issues[0];
    return {
      shouldContinue: false,
      reply: {
        text: `Config invalid after messaging window update (${issue.path}: ${issue.message}).`,
      },
    };
  }

  await replaceConfigFile({
    nextConfig: validated.config,
    afterWrite: { mode: "auto" },
  });

  const target = command.scope === "global" ? "global" : channel;
  const value = command.action === "reset" ? "unset" : formatMs(command.debounceMs);
  return {
    shouldContinue: false,
    reply: { text: `Messaging window for ${target} set to ${value}.` },
  };
};
