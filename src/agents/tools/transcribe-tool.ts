import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { runMediaUnderstandingFile } from "../../media-understanding/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const TranscribeToolSchema = Type.Object({
  file_path: Type.String({
    description: "Absolute path to an audio file to transcribe (e.g. .ogg, .wav, .mp3).",
  }),
});

export function createTranscribeTool(opts?: {
  config?: OpenClawConfig;
  agentDir?: string;
}): AnyAgentTool {
  return {
    label: "Transcribe Audio",
    name: "transcribe_audio",
    description:
      "Transcribe an audio file to text using the configured speech-to-text provider. " +
      "Accepts common formats: OGG, WAV, MP3, M4A, WEBM. " +
      "Returns the transcribed text.",
    parameters: TranscribeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const filePath = readStringParam(params, "file_path", { required: true });
      const cfg = opts?.config ?? loadConfig();

      const result = await runMediaUnderstandingFile({
        capability: "audio",
        filePath,
        cfg,
        agentDir: opts?.agentDir,
      });

      if (result.text) {
        return {
          content: [{ type: "text", text: result.text }],
          details: { provider: result.provider, model: result.model },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: "Transcription failed or returned empty result.",
          },
        ],
        details: { error: "no transcript" },
      };
    },
  };
}
