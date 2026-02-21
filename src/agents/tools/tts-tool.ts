import { Type } from "@sinclair/typebox";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { textToSpeech } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech." }),
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format (e.g. telegram)." }),
  ),
  delivery: optionalStringEnum(["auto", "path"], {
    description:
      'Delivery mode. "auto" (default) emits MEDIA for automatic send; "path" returns an AUDIO_PATH for manual message.send flows.',
  }),
});

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    description: `Convert text to speech. Default delivery is automatic from the tool result. Use delivery="path" when you will send audio manually via message.send to avoid duplicate sends. Reply with ${SILENT_REPLY_TOKEN} after successful auto delivery.`,
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const deliveryRaw = readStringParam(params, "delivery")?.trim().toLowerCase();
      const delivery = deliveryRaw === "path" ? "path" : "auto";
      const cfg = opts?.config ?? loadConfig();
      const result = await textToSpeech({
        text,
        cfg,
        channel: channel ?? opts?.agentChannel,
      });

      if (result.success && result.audioPath) {
        if (delivery === "path") {
          return {
            content: [{ type: "text", text: `AUDIO_PATH:${result.audioPath}` }],
            details: {
              audioPath: result.audioPath,
              provider: result.provider,
              delivery,
              voiceCompatible: result.voiceCompatible,
            },
          };
        }
        const lines: string[] = [];
        // Tag Telegram-compatible output as a voice bubble instead of a file attachment.
        if (result.voiceCompatible) {
          lines.push("[[audio_as_voice]]");
        }
        lines.push(`MEDIA:${result.audioPath}`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            audioPath: result.audioPath,
            provider: result.provider,
            delivery,
            voiceCompatible: result.voiceCompatible,
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
        details: { error: result.error },
      };
    },
  };
}
