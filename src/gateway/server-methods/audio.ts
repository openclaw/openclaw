// Gateway audio handlers expose bounded, short-lived transcription for trusted UI clients.
import fs from "node:fs/promises";
import path from "node:path";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runAudioTranscription } from "../../media-understanding/audio-transcription-runner.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const MAX_DICTATION_BYTES = 12 * 1024 * 1024;
const AUDIO_TYPES = new Map([
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
  ["audio/mp4", ".m4a"],
  ["audio/mpeg", ".mp3"],
  ["audio/wav", ".wav"],
]);

function normalizeAudioType(value: unknown): { mime: string; extension: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = AUDIO_TYPES.get(mime);
  return extension ? { mime, extension } : null;
}

function decodeAudio(value: unknown): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DICTATION_BYTES * 2) {
    return null;
  }
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value, "base64");
  return buffer.length > 0 && buffer.length <= MAX_DICTATION_BYTES ? buffer : null;
}

export const audioHandlers: GatewayRequestHandlers = {
  "audio.transcribe": async ({ params, respond, context }) => {
    const audio = decodeAudio(params.audio);
    const audioType = normalizeAudioType(params.mimeType);
    if (!audio || !audioType) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "audio.transcribe requires supported base64 audio no larger than 12 MB",
        ),
      );
      return;
    }

    let captureDir: string | null = null;
    try {
      const root = resolvePreferredOpenClawTmpDir();
      captureDir = await fs.mkdtemp(path.join(root, "dictation-"));
      const capturePath = path.join(captureDir, `capture${audioType.extension}`);
      // Mode 0600 protects the clip while CLI-backed providers read it; the whole
      // directory is removed in finally immediately after transcription.
      await fs.writeFile(capturePath, audio, { mode: 0o600 });
      const cfg = context.getRuntimeConfig();
      const result = await runAudioTranscription({
        cfg,
        ctx: {} as MsgContext,
        attachments: [{ path: capturePath, mime: audioType.mime, index: 0 }],
        localPathRoots: [captureDir],
      });
      if (!result.transcript) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "No speech was detected in the recording."),
        );
        return;
      }
      respond(true, { transcript: result.transcript });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    } finally {
      if (captureDir) {
        await fs.rm(captureDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  },
};
