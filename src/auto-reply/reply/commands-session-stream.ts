// Implements the session-scoped preview streaming command.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  resolveChannelPreviewStreamMode,
  type StreamingCompatEntry,
} from "../../channels/streaming.js";
import type { StreamingMode } from "../../config/types.base.js";
import { logVerbose } from "../../globals.js";
import { isSessionDefaultDirectiveValue } from "../thinking.js";
import { resolveChannelAccountId, resolveCommandSurfaceChannel } from "./channel-context.js";
import {
  persistSessionEntry,
  sessionEntryPersistenceConflictReply,
} from "./commands-session-store.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const STREAM_COMMAND_PREFIXES = ["/stream", "/streaming"] as const;

function matchStreamCommand(normalized: string): (typeof STREAM_COMMAND_PREFIXES)[number] | null {
  return (
    STREAM_COMMAND_PREFIXES.find(
      (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
    ) ?? null
  );
}

function normalizeStreamCommandMode(raw: string): StreamingMode | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  if (normalized === "final") {
    return "off";
  }
  return parseStreamCommandMode(normalized);
}

function parseStreamCommandMode(value: unknown): StreamingMode | undefined {
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return undefined;
}

function formatStreamModeLabel(mode: StreamingMode): string {
  return mode === "off" ? "off (final-only)" : mode;
}

function resolveStreamCommandSupported(params: HandleCommandsParams): boolean {
  const channelId = normalizeChannelId(
    params.command.channelId ?? resolveCommandSurfaceChannel(params),
  );
  if (!channelId) {
    return false;
  }
  return getChannelPlugin(channelId)?.capabilities?.previewStreamingSessionOverride === true;
}

function resolveStreamCommandChannelId(params: HandleCommandsParams) {
  return normalizeChannelId(params.command.channelId ?? resolveCommandSurfaceChannel(params));
}

function resolveStreamCommandDefaultMode(channelId: string | null): StreamingMode {
  return channelId === "discord" || channelId === "telegram" ? "progress" : "partial";
}

function resolveStreamCommandChannelConfig(params: HandleCommandsParams, channelId: string | null) {
  if (!channelId) {
    return undefined;
  }
  const resolvedAccount = getChannelPlugin(channelId)?.config?.resolveAccount?.(
    params.cfg,
    params.command.accountId ?? resolveChannelAccountId(params),
  ) as { config?: StreamingCompatEntry } | undefined;
  if (resolvedAccount?.config) {
    return resolvedAccount.config;
  }
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  return (channels?.[channelId] ??
    (params.cfg as Record<string, unknown> | undefined)?.[channelId]) as
    | StreamingCompatEntry
    | undefined;
}

function hasConfiguredPreviewStreaming(entry: StreamingCompatEntry | undefined): boolean {
  return entry?.streaming !== undefined;
}

export const handleStreamCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const prefix = matchStreamCommand(normalized);
  if (!prefix) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${prefix} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  if (!resolveStreamCommandSupported(params)) {
    return {
      shouldContinue: false,
      reply: { text: "⚙️ /stream isn't supported on this channel yet." },
    };
  }

  const rawArgs = normalized === prefix ? "" : normalized.slice(prefix.length).trim();
  const rawMode = normalizeLowercaseStringOrEmpty(rawArgs);
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!rawMode || rawMode === "status") {
    const currentMode = parseStreamCommandMode(targetSessionEntry?.streamingMode);
    if (currentMode) {
      return {
        shouldContinue: false,
        reply: { text: `⚙️ Current stream mode: ${formatStreamModeLabel(currentMode)} (session).` },
      };
    }
    const channelId = resolveStreamCommandChannelId(params);
    const channelConfig = resolveStreamCommandChannelConfig(params, channelId);
    const inheritedMode = hasConfiguredPreviewStreaming(channelConfig)
      ? resolveChannelPreviewStreamMode(channelConfig, resolveStreamCommandDefaultMode(channelId))
      : resolveStreamCommandDefaultMode(channelId);
    const source = hasConfiguredPreviewStreaming(channelConfig)
      ? "channel config"
      : "channel default";
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Current stream mode: ${formatStreamModeLabel(inheritedMode)} (${source}).`,
      },
    };
  }

  const resetsToDefault = isSessionDefaultDirectiveValue(rawMode);
  const nextMode = resetsToDefault ? undefined : normalizeStreamCommandMode(rawMode);
  if (nextMode === undefined) {
    if (resetsToDefault) {
      if (targetSessionEntry && params.sessionStore && params.sessionKey) {
        delete targetSessionEntry.streamingMode;
        if (
          !(await persistSessionEntry({
            ...params,
            sessionEntry: targetSessionEntry,
            touchedFields: ["streamingMode"],
          }))
        ) {
          return sessionEntryPersistenceConflictReply();
        }
      }
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Stream mode reset to channel default." },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: "⚙️ Usage: /stream status|off|partial|block|progress|default" },
    };
  }

  if (targetSessionEntry && params.sessionStore && params.sessionKey) {
    targetSessionEntry.streamingMode = nextMode;
    if (
      !(await persistSessionEntry({
        ...params,
        sessionEntry: targetSessionEntry,
        touchedFields: ["streamingMode"],
      }))
    ) {
      return sessionEntryPersistenceConflictReply();
    }
  }

  return {
    shouldContinue: false,
    reply: { text: `⚙️ Stream mode set to ${formatStreamModeLabel(nextMode)}.` },
  };
};
