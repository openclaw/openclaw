import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveTtsConfig } from "../../tts/tts-config.js";
import { textToSpeech } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech." }),
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Optional provider request timeout in milliseconds.",
      minimum: 1,
    }),
  ),
});

function readTtsTimeoutMs(args: Record<string, unknown>): number | undefined {
  const timeoutMs = readNumberParam(args, "timeoutMs", {
    integer: true,
    strict: true,
  });
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (timeoutMs <= 0) {
    throw new ToolInputError("timeoutMs must be a positive integer in milliseconds.");
  }
  return timeoutMs;
}

/**
 * Defuse reply-directive tokens inside spoken transcripts before they flow
 * through tool-result content. When verbose tool output is enabled,
 * `emitToolOutput` passes the content through `parseReplyDirectives`
 * (`src/media/parse.ts` / `src/utils/directive-tags.ts`), and unfiltered
 * `MEDIA:` or `[[audio_as_voice]]`-shaped tokens in the transcript would be
 * rewritten into actual media URLs and audio-as-voice flags. Insert a
 * zero-width word joiner so the regex patterns stop matching without
 * changing the visible text.
 */
function sanitizeTranscriptForToolContent(text: string): string {
  return text
    .replace(/^([^\S\r\n]*)MEDIA:/gim, "$1\u2060MEDIA:")
    .replace(/\[\[/g, "[\u2060[")
    .replace(/^([ \t]*)(`{3,})/gm, (_match, indent: string, fence: string) => {
      const [first = "", ...rest] = fence;
      return `${indent}${first}\u2060${rest.join("")}`;
    });
}

/**
 * Strip emoji and symbol characters from text for TTS.
 * Prevents TTS from speaking "checkmark" for "✓" or "copyright" for "©".
 */
function stripEmojiAndSymbols(text: string): string {
  // Unicode ranges for emoji and symbols
  // Emoji: \u{1F300}-\u{1F9FF}, \u{2600}-\u{27BF}, etc.
  // Symbols: \u{00A9}, \u{00AE}, \u{2122}, etc.
  return (
    text
      // Match emoji characters (common ranges)
      .replace(
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B50}-\u{2B55}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{3297}\u{3299}\u{3030}\u{303D}\u{26A0}\u{26A1}\u{26AA}-\u{26AB}\u{26B0}-\u{26B1}\u{26BD}-\u{26BE}\u{26C4}-\u{26C5}\u{26CE}\u{26CF}\u{26D1}\u{26D3}-\u{26D4}\u{26E9}\u{26F0}-\u{26F5}\u{26F7}-\u{26FA}\u{26FD}]/gu,
        "",
      )
      // Match common symbols (©, ®, ™, etc.)
      .replace(/[\u00A9\u00AE\u2122\u2120\u24C5\u24C6\u24DC\u24DD\u24DE\u24DF]/g, "")
  );
}

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentId?: string;
  agentAccountId?: string;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    displaySummary: "Convert text to speech and return audio.",
    description:
      "Use only for explicit audio intent (audio, voice, speech, TTS) or active TTS config. Never use for ordinary text replies. " +
      "Audio is delivered automatically from the tool result. After a successful call, follow the current conversation's reply instructions and avoid sending a duplicate text/audio response.",
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const timeoutMs = readTtsTimeoutMs(params);
      const cfg = opts?.config ?? getRuntimeConfig();
      const effectiveTts = resolveEffectiveTtsConfig(cfg, opts?.agentId);

      // Strip emoji/symbols if configured via messages.tts.skipEmojiSymbols
      let processedText = text;
      if (effectiveTts.skipEmojiSymbols) {
        processedText = stripEmojiAndSymbols(processedText);
      }

      const result = await textToSpeech({
        text: processedText,
        cfg,
        channel: channel ?? opts?.agentChannel,
        timeoutMs,
        agentId: opts?.agentId,
        accountId: opts?.agentAccountId,
      });

      if (result.success && result.audioPath) {
        // Preserve the spoken text in the tool result content so the session
        // transcript retains what was said across turns. The audio itself is
        // still delivered via details.media. Sanitize first so a crafted
        // utterance cannot inject reply directives when the tool output is
        // rendered in verbose mode.
        const resultText = effectiveTts.skipEmojiSymbols ? processedText : text;
        return {
          content: [
            { type: "text", text: `(spoken) ${sanitizeTranscriptForToolContent(resultText)}` },
          ],
          details: {
            audioPath: result.audioPath,
            provider: result.provider,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            media: {
              mediaUrl: result.audioPath,
              trustedLocalMedia: true,
              ...(result.audioAsVoice || result.voiceCompatible ? { audioAsVoice: true } : {}),
            },
          },
        };
      }

      throw new Error(result.error ?? "TTS conversion failed");
    },
  };
}
