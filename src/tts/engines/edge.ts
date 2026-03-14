import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { EdgeTTS } from "node-edge-tts";
import { logVerbose } from "../../globals.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { isVoiceCompatibleAudio } from "../../media/audio.js";
import type {
  TtsEngine,
  TtsSynthesizeRequest,
  TtsSynthesizeResult,
  TtsSynthesizeToFileResult,
} from "../engine.js";
import { inferEdgeExtension, scheduleCleanup } from "../tts-core.js";
import type { ResolvedTtsConfig } from "../tts.js";

const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

export class EdgeTtsEngine implements TtsEngine {
  readonly id = "edge";

  constructor(private readonly config: ResolvedTtsConfig["edge"]) {}

  isConfigured(): boolean {
    return this.config.enabled;
  }

  supportsTelephony(): boolean {
    return false;
  }

  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const result = await this.synthesizeToFile(request);
    const audio = readFileSync(result.audioPath);
    return { audio, format: result.format };
  }

  async synthesizeToFile(request: TtsSynthesizeRequest): Promise<TtsSynthesizeToFileResult> {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));

    let edgeOutputFormat = this.config.outputFormat;
    const fallbackEdgeOutputFormat =
      edgeOutputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

    const attemptEdgeTts = async (outputFormat: string) => {
      const extension = inferEdgeExtension(outputFormat);
      const audioPath = path.join(tempDir, `voice-${Date.now()}${extension}`);
      const tts = new EdgeTTS({
        voice: this.config.voice,
        lang: this.config.lang,
        outputFormat,
        saveSubtitles: this.config.saveSubtitles,
        proxy: this.config.proxy,
        rate: this.config.rate,
        pitch: this.config.pitch,
        volume: this.config.volume,
        timeout: this.config.timeoutMs ?? request.timeoutMs,
      });
      await tts.ttsPromise(request.text, audioPath);
      return { audioPath, outputFormat };
    };

    let edgeResult: { audioPath: string; outputFormat: string };
    try {
      edgeResult = await attemptEdgeTts(edgeOutputFormat);
    } catch (err) {
      if (fallbackEdgeOutputFormat && fallbackEdgeOutputFormat !== edgeOutputFormat) {
        logVerbose(
          `TTS: Edge output ${edgeOutputFormat} failed; retrying with ${fallbackEdgeOutputFormat}.`,
        );
        edgeOutputFormat = fallbackEdgeOutputFormat;
        try {
          edgeResult = await attemptEdgeTts(edgeOutputFormat);
        } catch (fallbackErr) {
          try {
            rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
          throw fallbackErr;
        }
      } else {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
        throw err;
      }
    }

    scheduleCleanup(tempDir);
    const voiceCompatible = isVoiceCompatibleAudio({ fileName: edgeResult.audioPath });

    return {
      audioPath: edgeResult.audioPath,
      format: edgeResult.outputFormat,
      voiceCompatible,
    };
  }
}
