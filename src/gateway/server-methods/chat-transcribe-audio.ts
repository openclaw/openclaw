import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extensionForMime, normalizeMimeType } from "../../media/mime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

type ChatTranscribeAudioRuntime = typeof import("./chat-transcribe-audio.runtime.js");
type TranscribeAudioFileResult = Awaited<
  ReturnType<ChatTranscribeAudioRuntime["transcribeAudioFile"]>
>;

let chatTranscribeAudioRuntimePromise: Promise<ChatTranscribeAudioRuntime> | null = null;

function loadChatTranscribeAudioRuntime(): Promise<ChatTranscribeAudioRuntime> {
  chatTranscribeAudioRuntimePromise ??= import("./chat-transcribe-audio.runtime.js");
  return chatTranscribeAudioRuntimePromise;
}

const CHAT_TRANSCRIBE_AUDIO_WS_JSON_OVERHEAD_BYTES = 64 * 1024;
export const MAX_CHAT_TRANSCRIBE_AUDIO_BYTES = Math.floor(
  ((MAX_PAYLOAD_BYTES - CHAT_TRANSCRIBE_AUDIO_WS_JSON_OVERHEAD_BYTES) * 3) / 4,
);

function decodeAudioPayload(params: Record<string, unknown>): {
  data: Buffer;
  mime?: string;
} {
  const dataUrl = normalizeOptionalString(params.audioDataUrl);
  const rawBase64 = normalizeOptionalString(params.audioBase64);
  const explicitMime = normalizeMimeType(normalizeOptionalString(params.mimeType));

  if (dataUrl) {
    const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(dataUrl);
    if (!match) {
      throw new Error("chat.transcribeAudio requires a base64 data URL");
    }
    const mime = normalizeMimeType(match[1]) ?? explicitMime;
    return { data: Buffer.from(match[2] ?? "", "base64"), mime };
  }

  if (rawBase64) {
    return { data: Buffer.from(rawBase64, "base64"), mime: explicitMime };
  }

  throw new Error("chat.transcribeAudio requires audioDataUrl or audioBase64");
}

function extensionForAudioMime(mime?: string): string {
  if (mime === "audio/webm") {
    return ".webm";
  }
  return extensionForMime(mime) ?? ".audio";
}

function isMissingMediaUnderstandingProvider(result: TranscribeAudioFileResult) {
  const decision = result.decision;
  return (
    decision?.outcome === "skipped" &&
    decision.attachments.length > 0 &&
    decision.attachments.every((attachment) => attachment.attempts.length === 0)
  );
}

export const chatTranscribeAudioHandlers: GatewayRequestHandlers = {
  "chat.transcribeAudio": async ({ params, respond, context }) => {
    let decoded: ReturnType<typeof decodeAudioPayload>;
    try {
      decoded = decodeAudioPayload(params);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }

    if (decoded.data.byteLength === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Audio payload is empty"));
      return;
    }
    if (decoded.data.byteLength > MAX_CHAT_TRANSCRIBE_AUDIO_BYTES) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Audio payload exceeds ${MAX_CHAT_TRANSCRIBE_AUDIO_BYTES} bytes`,
        ),
      );
      return;
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-stt-"));
    const filePath = path.join(tmpDir, `dictation${extensionForAudioMime(decoded.mime)}`);
    try {
      await fs.writeFile(filePath, decoded.data);
      const { transcribeAudioFile } = await loadChatTranscribeAudioRuntime();
      const result = await transcribeAudioFile({
        filePath,
        cfg: context.getRuntimeConfig(),
        mime: decoded.mime,
        language: normalizeOptionalString(params.language),
        prompt: normalizeOptionalString(params.prompt),
      });
      const text = result.text?.trim();
      if (!text) {
        const message = isMissingMediaUnderstandingProvider(result)
          ? "No audio transcription provider is configured or ready. Configure tools.media.audio.models."
          : "No transcript returned for audio";
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
        return;
      }
      respond(true, {
        text,
        provider: result.provider ?? null,
        model: result.model ?? null,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  },
};
