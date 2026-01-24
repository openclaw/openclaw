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

type ParsedTtsCommand = {
  action: string;
  args: string;
};

function parseTtsCommand(normalized: string): ParsedTtsCommand | null {
  // Accept `/tts` and `/tts <action> [args]` as a single control surface.
  if (normalized === "/tts") return { action: "status", args: "" };
  if (!normalized.startsWith("/tts ")) return null;
  const rest = normalized.slice(5).trim();
  if (!rest) return { action: "status", args: "" };
  const [action, ...tail] = rest.split(/\s+/);
  return { action: action.toLowerCase(), args: tail.join(" ").trim() };
}

function ttsUsage(): ReplyPayload {
  // Keep usage in one place so help/validation stays consistent.
  return {
    text:
      "⚙️ Usage: /tts <on|off|status|provider|limit|summary|audio> [value]" +
      "\nExamples:\n" +
      "/tts on\n" +
      "/tts provider openai\n" +
      "/tts limit 2000\n" +
      "/tts summary off\n" +
      "/tts audio Hello from Clawdbot",
  };
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;
  const parsed = parseTtsCommand(params.command.commandBodyNormalized);
  if (!parsed) return null;

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
    return { shouldContinue: false, reply: { text: "🔊 TTS enabled." } };
  }

  if (action === "off") {
    setTtsEnabled(prefsPath, false);
    return { shouldContinue: false, reply: { text: "🔇 TTS disabled." } };
  }

  if (action === "audio") {
    if (!args.trim()) {
      return { shouldContinue: false, reply: ttsUsage() };
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
      reply: { text: `❌ Error generating audio: ${result.error ?? "unknown error"}` },
    };
  }

  if (action === "provider") {
    const currentProvider = getTtsProvider(config, prefsPath);
    if (!args.trim()) {
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
            `Usage: /tts provider openai | elevenlabs`,
        },
      };
    }

    const requested = args.trim().toLowerCase();
    if (requested !== "openai" && requested !== "elevenlabs") {
      return { shouldContinue: false, reply: ttsUsage() };
    }

    setTtsProvider(prefsPath, requested);
    const fallback = requested === "openai" ? "elevenlabs" : "openai";
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS provider set to ${requested} (fallback: ${fallback}).` },
    };
  }

  if (action === "limit") {
    if (!args.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: { text: `📏 TTS limit: ${currentLimit} characters.` },
      };
    }
    const next = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 10_000) {
      return { shouldContinue: false, reply: ttsUsage() };
    }
    setTtsMaxLength(prefsPath, next);
    return {
      shouldContinue: false,
      reply: { text: `✅ TTS limit set to ${next} characters.` },
    };
  }

  if (action === "summary") {
    if (!args.trim()) {
      const enabled = isSummarizationEnabled(prefsPath);
      return {
        shouldContinue: false,
        reply: { text: `📝 TTS auto-summary: ${enabled ? "on" : "off"}.` },
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
        text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled.",
      },
    };
  }

  if (action === "status") {
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

  return { shouldContinue: false, reply: ttsUsage() };
};
