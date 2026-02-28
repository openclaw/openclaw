import { logVerbose } from "../../globals.js";
import {
  clearTtsElevenLabsVoiceId,
  getLastTtsAttempt,
  getTtsElevenLabsVoiceId,
  getTtsElevenLabsVoiceOverride,
  getTtsMaxLength,
  getTtsProvider,
  isValidVoiceId,
  isSummarizationEnabled,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setLastTtsAttempt,
  setSummarizationEnabled,
  setTtsEnabled,
  setTtsElevenLabsVoiceId,
  setTtsMaxLength,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

type ParsedTtsCommand = {
  action: string;
  args: string;
};

type ElevenLabsVoiceEntry = {
  voiceId: string;
  name: string;
};

function parseRawTtsArgs(rawCommandBody: string | undefined, action: string): string | undefined {
  const firstLine = rawCommandBody?.split(/\r?\n/, 1)[0];
  const trimmed = firstLine?.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  if (lowered === "/tts") {
    return "";
  }
  if (!lowered.startsWith("/tts ")) {
    return undefined;
  }
  const rest = trimmed.slice(5).trim();
  if (!rest) {
    return "";
  }
  const [rawAction, ...rawTail] = rest.split(/\s+/);
  if (rawAction.toLowerCase() !== action) {
    return undefined;
  }
  return rawTail.join(" ").trim();
}

function parseTtsCommand(normalized: string, rawCommandBody?: string): ParsedTtsCommand | null {
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
  const normalizedAction = action.toLowerCase();
  const normalizedArgs = tail.join(" ").trim();
  const rawArgs = parseRawTtsArgs(rawCommandBody, normalizedAction);
  return { action: normalizedAction, args: rawArgs ?? normalizedArgs };
}

function ttsUsage(): ReplyPayload {
  // Keep usage in one place so help/validation stays consistent.
  return {
    text:
      `🔊 **TTS (Text-to-Speech) Help**\n\n` +
      `**Commands:**\n` +
      `• /tts on — Enable automatic TTS for replies\n` +
      `• /tts off — Disable TTS\n` +
      `• /tts status — Show current settings\n` +
      `• /tts provider [name] — View/change provider\n` +
      `• /tts voice [voiceId|name|reset] — View/change ElevenLabs voice\n` +
      `• /tts limit [number] — View/change text limit\n` +
      `• /tts summary [on|off] — View/change auto-summary\n` +
      `• /tts audio <text> — Generate audio from text\n\n` +
      `**Providers:**\n` +
      `• edge — Free, fast (default)\n` +
      `• openai — High quality (requires API key)\n` +
      `• elevenlabs — Premium voices (requires API key)\n\n` +
      `**Text Limit (default: 1500, max: 4096):**\n` +
      `When text exceeds the limit:\n` +
      `• Summary ON: AI summarizes, then generates audio\n` +
      `• Summary OFF: Truncates text, then generates audio\n\n` +
      `**Examples:**\n` +
      `/tts provider edge\n` +
      `/tts voice pMsXgVXv3BLzUgSXRplE\n` +
      `/tts limit 2000\n` +
      `/tts audio Hello, this is a test!`,
  };
}

function normalizeElevenLabsVoiceApiBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

async function fetchElevenLabsVoices(
  apiKey: string,
  baseUrl: string,
): Promise<ElevenLabsVoiceEntry[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${normalizeElevenLabsVoiceApiBase(baseUrl)}/v1/voices`, {
      headers: {
        "xi-api-key": apiKey,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ElevenLabs voices API error (${response.status})`);
    }
    const json = (await response.json()) as {
      voices?: Array<{ voice_id?: string; name?: string }>;
    };
    const voices = (json.voices ?? [])
      .map((voice) => ({
        voiceId: voice.voice_id?.trim() ?? "",
        name: voice.name?.trim() ?? "",
      }))
      .filter((voice) => voice.voiceId && voice.name && isValidVoiceId(voice.voiceId));
    return voices;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveVoiceByName(
  voices: ElevenLabsVoiceEntry[],
  query: string,
):
  | { kind: "matched"; voice: ElevenLabsVoiceEntry }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: ElevenLabsVoiceEntry[] } {
  const normalizedQuery = query.trim().toLowerCase();
  const exact = voices.filter((voice) => voice.name.toLowerCase() === normalizedQuery);
  if (exact.length === 1) {
    return { kind: "matched", voice: exact[0] };
  }
  if (exact.length > 1) {
    return { kind: "ambiguous", candidates: exact };
  }
  const partial = voices.filter((voice) => voice.name.toLowerCase().includes(normalizedQuery));
  if (partial.length === 1) {
    return { kind: "matched", voice: partial[0] };
  }
  if (partial.length > 1) {
    return { kind: "ambiguous", candidates: partial };
  }
  return { kind: "not_found" };
}

export const handleTtsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseTtsCommand(
    params.command.commandBodyNormalized,
    params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
  );
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
    return { shouldContinue: false, reply: { text: "🔊 TTS enabled." } };
  }

  if (action === "off") {
    setTtsEnabled(prefsPath, false);
    return { shouldContinue: false, reply: { text: "🔇 TTS disabled." } };
  }

  if (action === "audio") {
    if (!args.trim()) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎤 Generate audio from text.\n\n` +
            `Usage: /tts audio <text>\n` +
            `Example: /tts audio Hello, this is a test!`,
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
      reply: { text: `❌ Error generating audio: ${result.error ?? "unknown error"}` },
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
            `🎙️ TTS provider\n` +
            `Primary: ${currentProvider}\n` +
            `OpenAI key: ${hasOpenAI ? "✅" : "❌"}\n` +
            `ElevenLabs key: ${hasElevenLabs ? "✅" : "❌"}\n` +
            `Edge enabled: ${hasEdge ? "✅" : "❌"}\n` +
            `Usage: /tts provider openai | elevenlabs | edge`,
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
      reply: { text: `✅ TTS provider set to ${requested}.` },
    };
  }

  if (action === "voice") {
    const overrideVoiceId = getTtsElevenLabsVoiceOverride(prefsPath);
    const effectiveVoiceId = getTtsElevenLabsVoiceId(config, prefsPath);
    if (!args.trim()) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `🎤 ElevenLabs voice\n` +
            `Current: ${effectiveVoiceId}\n` +
            `Source: ${overrideVoiceId ? "local override" : "config default"}\n` +
            `Usage: /tts voice <voiceId|voice-name|reset>`,
        },
      };
    }

    const requestedRaw = args.trim();
    const requested = requestedRaw.toLowerCase();
    if (requested === "reset" || requested === "clear" || requested === "default") {
      clearTtsElevenLabsVoiceId(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text: `✅ ElevenLabs voice reset to config default (${config.elevenlabs.voiceId}).`,
        },
      };
    }

    if (isValidVoiceId(requestedRaw)) {
      setTtsElevenLabsVoiceId(prefsPath, requestedRaw);
      return {
        shouldContinue: false,
        reply: { text: `✅ ElevenLabs voice set to ${requestedRaw.trim()}.` },
      };
    }

    const apiKey = resolveTtsApiKey(config, "elevenlabs");
    if (!apiKey) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `❌ Cannot resolve ElevenLabs voice name without API key.\n` +
            `Set ELEVENLABS_API_KEY (or XI_API_KEY), or use a direct voiceId.`,
        },
      };
    }

    try {
      const voices = await fetchElevenLabsVoices(apiKey, config.elevenlabs.baseUrl);
      const resolved = resolveVoiceByName(voices, requestedRaw);
      if (resolved.kind === "matched") {
        setTtsElevenLabsVoiceId(prefsPath, resolved.voice.voiceId);
        return {
          shouldContinue: false,
          reply: {
            text: `✅ ElevenLabs voice set to ${resolved.voice.name} (${resolved.voice.voiceId}).`,
          },
        };
      }
      if (resolved.kind === "ambiguous") {
        const preview = resolved.candidates
          .slice(0, 5)
          .map((voice) => `- ${voice.name} (${voice.voiceId})`)
          .join("\n");
        return {
          shouldContinue: false,
          reply: {
            text:
              `⚠️ Multiple ElevenLabs voices match "${requestedRaw}". Please use voiceId.\n` +
              preview,
          },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text:
            `❌ No ElevenLabs voice matched "${requestedRaw}".\n` +
            `Use /tts voice <voiceId> or a more specific voice name.`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        shouldContinue: false,
        reply: { text: `❌ Failed to load ElevenLabs voices: ${message}` },
      };
    }
  }

  if (action === "limit") {
    if (!args.trim()) {
      const currentLimit = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text:
            `📏 TTS limit: ${currentLimit} characters.\n\n` +
            `Text longer than this triggers summary (if enabled).\n` +
            `Range: 100-4096 chars (Telegram max).\n\n` +
            `To change: /tts limit <number>\n` +
            `Example: /tts limit 2000`,
        },
      };
    }
    const next = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(next) || next < 100 || next > 4096) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Limit must be between 100 and 4096 characters." },
      };
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
      const maxLen = getTtsMaxLength(prefsPath);
      return {
        shouldContinue: false,
        reply: {
          text:
            `📝 TTS auto-summary: ${enabled ? "on" : "off"}.\n\n` +
            `When text exceeds ${maxLen} chars:\n` +
            `• ON: summarizes text, then generates audio\n` +
            `• OFF: truncates text, then generates audio\n\n` +
            `To change: /tts summary on | off`,
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
        text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled.",
      },
    };
  }

  if (action === "status") {
    const enabled = isTtsEnabled(config, prefsPath);
    const provider = getTtsProvider(config, prefsPath);
    const hasKey = isTtsProviderConfigured(config, provider);
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath);
    const elevenlabsVoiceId = getTtsElevenLabsVoiceId(config, prefsPath);
    const elevenlabsVoiceSource = getTtsElevenLabsVoiceOverride(prefsPath) ? "override" : "config";
    const last = getLastTtsAttempt();
    const lines = [
      "📊 TTS status",
      `State: ${enabled ? "✅ enabled" : "❌ disabled"}`,
      `Provider: ${provider} (${hasKey ? "✅ configured" : "❌ not configured"})`,
      `ElevenLabs voice: ${elevenlabsVoiceId} (${elevenlabsVoiceSource})`,
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
