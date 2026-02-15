import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";
import { logVerbose } from "../../globals.js";
import { t } from "../../i18n/index.js";
import {
  getLastTtsAttempt,
  getTtsMaxLength,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsEnabled,
  setTtsMaxLength,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";

type ParsedTtsCommand = {
  action: string;
  args: string;
};

function parseTtsCommand(normalized: string): ParsedTtsCommand | null {
  // Accept `/tts` and `/tts <action> [args]` as a single control surface.
  if (normalized === "/tts") {
    return { action: "status", args: "" };
  }
  if (!normalized.startsWith("/tts ")) {
    return null;
  }
  const rest = normalized.slice(5).trim();
  if (!rest) {
    return { action: "status", args: "" };
  }
  const [action, ...tail] = rest.split(/\s+/);
  return { action: action.toLowerCase(), args: tail.join(" ").trim() };
}

function ttsUsage(): ReplyPayload {
  // Keep usage in one place so help/validation stays consistent.
  return {
    text:
      `${t("auto_reply.tts.help_title")}\n\n` +
      `${t("auto_reply.tts.commands_title")}\n` +
      `${t("auto_reply.tts.command_on")}\n` +
      `${t("auto_reply.tts.command_off")}\n` +
      `${t("auto_reply.tts.command_status")}\n` +
      `${t("auto_reply.tts.command_provider_view")}\n` +
      `${t("auto_reply.tts.command_limit_view")}\n` +
      `${t("auto_reply.tts.command_summary")}\n` +
      `${t("auto_reply.tts.command_audio")}\n\n` +
      `${t("auto_reply.tts.providers_title")}\n` +
      `${t("auto_reply.tts.provider_edge")}\n` +
      `${t("auto_reply.tts.provider_openai_tts")}\n` +
      `${t("auto_reply.tts.provider_elevenlabs_tts")}\n\n` +
      `${t("auto_reply.tts.text_limit_title")}\n` +
      `${t("auto_reply.tts.text_limit_desc")}\n` +
      `${t("auto_reply.tts.summary_on")}\n` +
      `${t("auto_reply.tts.summary_off")}\n\n` +
      `${t("auto_reply.tts.examples_title")}\n` +
      `${t("auto_reply.tts.examples_text")}`,
  };
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTtsCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring TTS command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const config = resolveTtsConfig(params.cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const action = parsed.action;
  const args = parsed.args;

  if (action === "help") {
    return { shouldContinue: false, reply: ttsUsage() };
  }

  if (action === "on") {
    setTtsEnabled(prefsPath, true);
    return { shouldContinue: false, reply: { text: t("auto_reply.tts.enabled") } };
  }

  if (action === "off") {
    setTtsEnabled(prefsPath, false);
    return { shouldContinue: false, reply: { text: t("auto_reply.tts.disabled") } };
  }

  if (action === "audio") {
    if (!args.trim()) {
      return {
        shouldContinue: false,
        reply: {
          text: `${t("auto_reply.tts.audio_usage_title")}\n\n${t("auto_reply.tts.audio_usage_text")}`,
        },
      };
    }

    const start = Date.now();
    const result = await textToSpeech({
      text: args,
      cfg: params.cfg,
      channel: params.command.channel,
      prefsPath,
    });

    if (result.success && result.audioPath) {
      // Store last attempt for `/tts status`.
      setLastTtsAttempt({
        timestamp: Date.now(),
        success: true,
        textLength: args.length,
        summarized: false,
        provider: result.provider,
        latencyMs: result.latencyMs,
      });
      const payload: ReplyPayload = {
        mediaUrl: result.audioPath,
        audioAsVoice: result.voiceCompatible === true,
      };
      return { shouldContinue: false, reply: payload };
    }

    // Store failure details for `/tts status`.
    setLastTtsAttempt({
      timestamp: Date.now(),
      success: false,
      textLength: args.length,
      summarized: false,
      error: result.error,
      latencyMs: Date.now() - start,
    });
    return {
      shouldContinue: false,
      reply: { text: t("auto_reply.tts.error_generating", { error: result.error ?? "unknown error" }) },
    };
  }

  if (action === "provider") {
    const currentProvider = getTtsProvider(config, prefsPath);
    if (!args.trim()) {
      const hasOpenAI = Boolean(resolveTtsApiKey(config, "openai"));
      const hasElevenLabs = Boolean(resolveTtsApiKey(config, "elevenlabs"));
      const hasEdge = isTtsProviderConfigured(config, "edge");
      return {
        shouldContinue: false,
        reply: {
          text:
            `${t("auto_reply.tts.provider_title")}\n` +
            `${t("auto_reply.tts.provider_primary")}: ${currentProvider}\n` +
            `${t("auto_reply.tts.provider_openai_key")}: ${hasOpenAI ? "✅" : "❌"}\n` +
            `${t("auto_reply.tts.provider_elevenlabs_key")}: ${hasElevenLabs ? "✅" : "❌"}\n` +
            `${t("auto_reply.tts.provider_edge_enabled")}: ${hasEdge ? "✅" : "❌"}\n` +
            `${t("auto_reply.tts.provider_usage")}`,
        },
      };
    }

    const requested = args.trim().toLowerCase();
    if (requested !== "openai" && requested !== "elevenlabs" && requested !== "edge") {
      return { shouldContinue: false, reply: ttsUsage() };
    }

    setTtsProvider(prefsPath, requested);
    return {
      shouldContinue: false,
      reply: { text: t("auto_reply.tts.provider_set", { provider: requested }) },
    };
  }

  if (action === "limit") {
    if (!args.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text: `${t("auto_reply.tts.limit_title", { limit: currentLimit })}\n\n${t("auto_reply.tts.limit_description")}`,
        },
      };
    }
    const next = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 4096) {
      return {
        shouldContinue: false,
        reply: { text: t("auto_reply.tts.limit_invalid") },
      };
    }
    setTtsMaxLength(prefsPath, next);
    return {
      shouldContinue: false,
      reply: { text: t("auto_reply.tts.limit_set", { limit: next }) },
    };
  }

  if (action === "summary") {
    if (!args.trim()) {
      const enabled = isSummarizationEnabled(prefsPath);
      const maxLen = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text: `${t("auto_reply.tts.summary_title", { enabled: enabled ? t("auto_reply.tts.status_on") : t("auto_reply.tts.status_off") })}\n\n${t("auto_reply.tts.summary_description", { maxLen })}`,
        },
      };
    }
    const requested = args.trim().toLowerCase();
    if (requested !== "on" && requested !== "off") {
      return { shouldContinue: false, reply: ttsUsage() };
    }
    setSummarizationEnabled(prefsPath, requested === "on");
    return {
      shouldContinue: false,
      reply: {
        text: requested === "on" ? t("auto_reply.tts.summary_enabled") : t("auto_reply.tts.summary_disabled"),
      },
    };
  }

  if (action === "status") {
    const enabled = isTtsEnabled(config, prefsPath);
    const provider = getTtsProvider(config, prefsPath);
    const hasKey = isTtsProviderConfigured(config, provider);
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath);
    const last = getLastTtsAttempt();
    const lines = [
      t("auto_reply.tts.status_title"),
      `${t("auto_reply.tts.status_state")}: ${enabled ? t("auto_reply.tts.status_enabled") : t("auto_reply.tts.status_disabled")}`,
      `${t("auto_reply.tts.status_provider")}: ${provider} (${hasKey ? t("auto_reply.tts.status_configured") : t("auto_reply.tts.status_not_configured")})`,
      `${t("auto_reply.tts.status_text_limit")}: ${maxLength} chars`,
      `${t("auto_reply.tts.status_auto_summary")}: ${summarize ? t("auto_reply.tts.status_on") : t("auto_reply.tts.status_off")}`,
    ];
    if (last) {
      const timeAgo = Math.round((Date.now() - last.timestamp) / 1000);
      lines.push("");
      lines.push(`${t("auto_reply.tts.status_last_attempt", { timeAgo })}: ${last.success ? "✅" : "❌"}`);
      lines.push(t("auto_reply.tts.status_text_chars", { 
        textLength: last.textLength, 
        summarized: last.summarized ? t("auto_reply.tts.status_text_summarized") : ""
      }));
      if (last.success) {
        lines.push(`${t("auto_reply.tts.status_provider_used")}: ${last.provider ?? "unknown"}`);
        lines.push(`${t("auto_reply.tts.status_latency")}: ${last.latencyMs ?? 0}ms`);
      } else if (last.error) {
        lines.push(`${t("auto_reply.tts.status_error")}: ${last.error}`);
      }
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  return { shouldContinue: false, reply: ttsUsage() };
};
