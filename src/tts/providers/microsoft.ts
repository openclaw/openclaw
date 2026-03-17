import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { isVoiceCompatibleAudio } from "../../media/audio.js";
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { edgeTTS, inferEdgeExtension } from "../tts-core.js";

const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export function buildMicrosoftSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "microsoft",
    label: "Microsoft",
    aliases: ["edge"],
    isConfigured: ({ config }) => config.edge.enabled,
    synthesize: async (req) => {
      const tempRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = mkdtempSync(path.join(tempRoot, "tts-microsoft-"));
      let outputFormat = req.config.edge.outputFormat;
      const fallbackOutputFormat =
        outputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

      try {
        const runEdge = async (format: string) => {
          const fileExtension = inferEdgeExtension(format);
          const outputPath = path.join(tempDir, `speech${fileExtension}`);
          await edgeTTS({
            text: req.text,
            outputPath,
            config: {
              ...req.config.edge,
              outputFormat: format,
            },
            timeoutMs: req.config.timeoutMs,
          });
          const audioBuffer = readFileSync(outputPath);
          return {
            audioBuffer,
            outputFormat: format,
            fileExtension,
            voiceCompatible: isVoiceCompatibleAudio({ fileName: outputPath }),
          };
        };

        try {
          return await runEdge(outputFormat);
        } catch (err) {
          if (!fallbackOutputFormat || fallbackOutputFormat === outputFormat) {
            throw err;
          }
          outputFormat = fallbackOutputFormat;
          return await runEdge(outputFormat);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}
