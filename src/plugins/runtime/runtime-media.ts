import { isVoiceCompatibleAudio } from "../../media/audio.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { getAudioDurationMs } from "../../media/ffmpeg-exec.js";
import { getImageMetadata, resizeToJpeg } from "../../media/image-ops.js";
import { detectMime } from "../../media/mime.js";
import { loadWebMedia } from "../../web/media.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeMedia(): PluginRuntime["media"] {
  return {
    loadWebMedia,
    detectMime,
    mediaKindFromMime,
    isVoiceCompatibleAudio,
    getImageMetadata,
    resizeToJpeg,
    getAudioDurationMs,
  };
}
