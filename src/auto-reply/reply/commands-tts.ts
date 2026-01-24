import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";
import {
  getLastTtsAttempt,
  getTtsMaxLength,
  getTtsProvider,
  isSummarizationEnabled,
  isTtsEnabled,
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

function parseCommandArg(normalized: string, command: string): string | null {
  if (normalized === command) return "";
  if (normalized.startsWith(`${command} `)) return normalized.slice(command.length).trim();
  return null;
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const normalized = params.command.commandBodyNormalized;
  if (
    !normalized.startsWith("/tts_") &&
    normalized !== "/audio" &&
    !normalized.startsWith("/audio ")
  ) {
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

  if (normalized === "/tts_on") {
    setTtsEnabled(prefsPath, true);
    return { shouldContinue: false, reply: { text: "🔊 TTS enabled." } };
  }

  if (normalized === "/tts_off") {
    setTtsEnabled(prefsPath, false);
    return { shouldContinue: false, reply: { text: "🔇 TTS disabled." } };
  }

  const audioArg = parseCommandArg(normalized, "/audio");
  if (audioArg !== null) {
    if (!audioArg.trim()) {
      return { shouldContinue: false, reply: { text: "⚙️ Usage: /audio <text>" } };
    }

    const start = Date.now();
    const result = await textToSpeech({
      text: audioArg,
      cfg: params.cfg,
      channel: params.command.channel,
      prefsPath,
    });

    if (result.success && result.audioPath) {
      setLastTtsAttempt({
        timestamp: Date.now(),
        success: true,
        textLength: audioArg.length,
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

    setLastTtsAttempt({
      timestamp: Date.now(),
      success: false,
      textLength: audioArg.length,
      summarized: false,
      error: result.error,
      latencyMs: Date.now() - start,
    });
    return {
      shouldContinue: false,
      reply: { text: `❌ Error generating audio: ${result.error ?? "unknown error"}` },
    };
  }

  const providerArg = parseCommandArg(normalized, "/tts_provider");
  if (providerArg !== null) {
    const currentProvider = getTtsProvider(config, prefsPath);
    if (!providerArg.trim()) {
      const fallback = currentProvider === "openai" ? "elevenlabs" : "openai";
      const hasOpenAI = Boolean(resolveTtsApiKey(config, "openai"));
      const hasElevenLabs = Boolean(resolveTtsApiKey(config, "elevenlabs"));
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎙️ TTS provider\n` +
            `Primary: ${currentProvider}\n` +
            `Fallback: ${fallback}\n` +
            `OpenAI key: ${hasOpenAI ? "✅" : "❌"}\n` +
            `ElevenLabs key: ${hasElevenLabs ? "✅" : "❌"}\n` +
            `Usage: /tts_provider openai | elevenlabs`,
        },
      };
    }

    const requested = providerArg.trim().toLowerCase();
    if (requested !== "openai" && requested !== "elevenlabs") {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /tts_provider openai | elevenlabs" },
      };
    }

    setTtsProvider(prefsPath, requested);
    const fallback = requested === "openai" ? "elevenlabs" : "openai";
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS provider set to ${requested} (fallback: ${fallback}).` },
    };
  }

  const limitArg = parseCommandArg(normalized, "/tts_limit");
  if (limitArg !== null) {
    if (!limitArg.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: { text: `📏 TTS limit: ${currentLimit} characters.` },
      };
    }
    const next = Number.parseInt(limitArg.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 10_000) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /tts_limit <100-10000>" },
      };
    }
    setTtsMaxLength(prefsPath, next);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS limit set to ${next} characters.` },
    };
  }

  const summaryArg = parseCommandArg(normalized, "/tts_summary");
  if (summaryArg !== null) {
    if (!summaryArg.trim()) {
      const enabled = isSummarizationEnabled(prefsPath);
      return {
        shouldContinue: false,
        reply: { text: `📝 TTS auto-summary: ${enabled ? "on" : "off"}.` },
      };
    }
    const requested = summaryArg.trim().toLowerCase();
    if (requested !== "on" && requested !== "off") {
      return { shouldContinue: false, reply: { text: "⚙️ Usage: /tts_summary on|off" } };
    }
    setSummarizationEnabled(prefsPath, requested === "on");
    return {
      shouldContinue: false,
      reply: {
        text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled.",
      },
    };
  }

  if (normalized === "/tts_status") {
    const enabled = isTtsEnabled(config, prefsPath);
    const provider = getTtsProvider(config, prefsPath);
    const hasKey = Boolean(resolveTtsApiKey(config, provider));
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath);
    const last = getLastTtsAttempt();
    const lines = [
      "📊 TTS status",
      `State: ${enabled ? "✅ enabled" : "❌ disabled"}`,
      `Provider: ${provider} (${hasKey ? "✅ key" : "❌ no key"})`,
      `Text limit: ${maxLength} chars`,
      `Auto-summary: ${summarize ? "on" : "off"}`,
    ];
    if (last) {
      const timeAgo = Math.round((Date.now() - last.timestamp) / 1000);
      lines.push("");
      lines.push(`Last attempt (${timeAgo}s ago): ${last.success ? "✅" : "❌"}`);
      lines.push(`Text: ${last.textLength} chars${last.summarized ? " (summarized)" : ""}`);
      if (last.success) {
        lines.push(`Provider: ${last.provider ?? "unknown"}`);
        lines.push(`Latency: ${last.latencyMs ?? 0}ms`);
      } else if (last.error) {
        lines.push(`Error: ${last.error}`);
      }
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  return null;
};
