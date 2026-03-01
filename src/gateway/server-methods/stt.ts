import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requireApiKey, resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { loadConfig } from "../../config/config.js";
import { DEFAULT_AUDIO_MODELS } from "../../media-understanding/defaults.js";
import { getMediaUnderstandingProvider } from "../../media-understanding/providers/index.js";
import {
  buildProviderRegistry,
  resolveAutoEntries,
  resolveLocalAudioEntry,
} from "../../media-understanding/runner.js";
import { runExec } from "../../process/exec.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Formats natively supported by whisper-cli. */
const WHISPER_NATIVE_FORMATS = new Set(["wav", "flac", "mp3", "ogg"]);

/** Check if a MIME type can be fed directly to whisper-cli. */
function isWhisperNative(mime: string): boolean {
  const lower = mime.toLowerCase();
  for (const fmt of WHISPER_NATIVE_FORMATS) {
    if (lower.includes(fmt)) {
      return true;
    }
  }
  return false;
}

/** Convert an audio file to 16kHz mono WAV using ffmpeg (required for whisper-cli). */
async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = inputPath.replace(/\.[^.]+$/, "") + ".wav";
  await runExec("ffmpeg", ["-i", inputPath, "-ar", "16000", "-ac", "1", "-y", wavPath], {
    timeoutMs: 30_000,
  });
  return wavPath;
}

export const sttHandlers: GatewayRequestHandlers = {
  "stt.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const providerRegistry = buildProviderRegistry();
      const entries = await resolveAutoEntries({ cfg, providerRegistry, capability: "audio" });
      const localEntry = await resolveLocalAudioEntry();
      respond(true, {
        available: entries.length > 0,
        providers: entries.map((e) => ({ id: e.provider ?? e.command ?? "cli", type: e.type })),
        hasLocal: localEntry !== null,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },

  "stt.transcribe": async ({ params, respond }) => {
    const audio = typeof params.audio === "string" ? params.audio : "";
    const mime = typeof params.mime === "string" ? params.mime : "audio/webm";
    const language = typeof params.language === "string" ? params.language : undefined;

    if (!audio) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "stt.transcribe requires audio (base64)"),
      );
      return;
    }

    const cleanupPaths: string[] = [];
    try {
      const cfg = loadConfig();
      const providerRegistry = buildProviderRegistry();

      const entries = await resolveAutoEntries({ cfg, providerRegistry, capability: "audio" });
      if (entries.length === 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "No STT provider available. Install whisper-cpp, sherpa-onnx, or configure an API key (openai, groq, deepgram).",
          ),
        );
        return;
      }

      const entry = entries[0];
      const buffer = Buffer.from(audio, "base64");

      const ext = mime.includes("wav")
        ? ".wav"
        : mime.includes("webm")
          ? ".webm"
          : mime.includes("ogg")
            ? ".ogg"
            : mime.includes("mp3")
              ? ".mp3"
              : ".webm";
      const tmpPath = path.join(os.tmpdir(), `openclaw-stt-${Date.now()}${ext}`);
      await fs.writeFile(tmpPath, buffer);
      cleanupPaths.push(tmpPath);

      if (entry.type === "cli") {
        const command = entry.command;
        if (!command) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "CLI entry missing command"),
          );
          return;
        }

        // whisper-cli only supports wav/flac/mp3/ogg — convert webm via ffmpeg
        let mediaPath = tmpPath;
        if (!isWhisperNative(mime)) {
          mediaPath = await convertToWav(tmpPath);
          cleanupPaths.push(mediaPath);
        }

        // whisper-cli writes output to a file via -otxt -of <base>
        // We need to resolve the output file path and read it after execution.
        const outputBase = path.join(os.tmpdir(), `openclaw-stt-out-${Date.now()}`);
        const outputTxtPath = `${outputBase}.txt`;
        cleanupPaths.push(outputTxtPath);

        const args = (entry.args ?? []).map((a: string) =>
          a
            .replace(/\{\{MediaPath\}\}/g, mediaPath)
            .replace(/\{\{OutputBase\}\}/g, outputBase)
            .replace(/\{\{Prompt\}\}/g, "Transcribe the audio."),
        );

        await runExec(command, args, {
          timeoutMs: 60_000,
          maxBuffer: 1024 * 1024,
        });

        // Read the output text file produced by whisper-cli
        let text = "";
        try {
          text = (await fs.readFile(outputTxtPath, "utf8")).trim();
        } catch {
          // If file doesn't exist, whisper-cli may have produced no output
        }

        respond(true, { text, provider: command, model: undefined });
      } else if (entry.type === "provider" && entry.provider) {
        const provider = getMediaUnderstandingProvider(entry.provider, providerRegistry);
        if (!provider?.transcribeAudio) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Provider ${entry.provider} does not support audio transcription`,
            ),
          );
          return;
        }

        const auth = await resolveApiKeyForProvider({ provider: entry.provider, cfg });
        const apiKey = requireApiKey(auth, entry.provider);

        const model = entry.model?.trim() || DEFAULT_AUDIO_MODELS[entry.provider];

        const fileName = path.basename(tmpPath);
        const result = await provider.transcribeAudio({
          buffer,
          fileName,
          mime,
          apiKey,
          model,
          language,
          timeoutMs: 60_000,
        });

        respond(true, {
          text: result.text,
          provider: entry.provider,
          model: result.model ?? model,
        });
      } else {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Unsupported STT provider entry type"),
        );
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    } finally {
      for (const p of cleanupPaths) {
        fs.unlink(p).catch(() => {});
      }
    }
  },
};
