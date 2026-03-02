import { Type } from "@sinclair/typebox";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { textToSpeech, type TtsDirectiveOverrides } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech." }),
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format (e.g. telegram)." }),
  ),
  instructions: Type.Optional(
    Type.String({ description: "Optional OpenAI speech instructions for this conversion." }),
  ),
  stream: Type.Optional(
    Type.Boolean({
      description: "Optional OpenAI stream-mode request for this conversion (buffered fallback).",
    }),
  ),
});

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    description: `Convert text to speech. Audio is delivered automatically from the tool result — reply with ${SILENT_REPLY_TOKEN} after a successful call to avoid duplicate messages.`,
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const instructions = readStringParam(params, "instructions");
      const stream = typeof params.stream === "boolean" ? params.stream : undefined;
      const cfg = opts?.config ?? loadConfig();
      const overrides: TtsDirectiveOverrides | undefined =
        instructions != null || stream !== undefined
          ? {
              openai: {
                ...(instructions != null ? { instructions } : {}),
                ...(stream !== undefined ? { stream } : {}),
              },
            }
          : undefined;
      const result = await textToSpeech({
        text,
        cfg,
        channel: channel ?? opts?.agentChannel,
        overrides,
      });

      if (result.success && result.audioPath) {
        const lines: string[] = [];
        // Tag Telegram Opus output as a voice bubble instead of a file attachment.
        if (result.voiceCompatible) {
          lines.push("[[audio_as_voice]]");
        }
        lines.push(`MEDIA:${result.audioPath}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { audioPath: result.audioPath, provider: result.provider },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.error ?? "TTS conversion failed",
          },
        ],
        details: { error: result.error },
      };
    },
  };
}
