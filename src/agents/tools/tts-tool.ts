import { Type } from "@sinclair/typebox";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { textToSpeech } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech." }),
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format (e.g. telegram)." }),
  ),
  deliveryMode: Type.Optional(
    Type.Union([Type.Literal("send"), Type.Literal("return")], {
      description:
        "Delivery mode: 'send' (default) returns MEDIA output for normal delivery; 'return' returns metadata only without MEDIA output.",
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
      const deliveryModeRaw = readStringParam(params, "deliveryMode");
      const deliveryMode = deliveryModeRaw == null || deliveryModeRaw === "" ? "send" : deliveryModeRaw;
      if (deliveryMode !== "send" && deliveryMode !== "return") {
        return {
          content: [
            {
              type: "text",
              text: "deliveryMode must be one of: send, return",
            },
          ],
          details: {
            ok: false,
            error: {
              code: "VALIDATION_ERROR",
              message: "deliveryMode must be one of: send, return",
            },
          },
        };
      }
      const cfg = opts?.config ?? loadConfig();
      const result = await textToSpeech({
        text,
        cfg,
        channel: channel ?? opts?.agentChannel,
      });

      if (result.success && result.audioPath) {
        if (deliveryMode === "return") {
          return {
            content: [
              {
                type: "text",
                text: "TTS audio generated (return mode).",
              },
            ],
            details: {
              ok: true,
              deliveryMode: "return",
              audioPath: result.audioPath,
              mimeType: result.voiceCompatible ? "audio/ogg" : "audio/mpeg",
              sent: false,
              provider: result.provider,
            },
          };
        }

        const lines: string[] = [];
        // Tag Telegram Opus output as a voice bubble instead of a file attachment.
        if (result.voiceCompatible) {
          lines.push("[[audio_as_voice]]");
        }
        lines.push(`MEDIA:${result.audioPath}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            ok: true,
            audioPath: result.audioPath,
            provider: result.provider,
            deliveryMode: "send",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.error ?? "TTS conversion failed",
          },
        ],
        details: {
          ok: false,
          error: {
            code: "TTS_GENERATION_FAILED",
            message: result.error ?? "TTS conversion failed",
          },
        },
      };
    },
  };
}
