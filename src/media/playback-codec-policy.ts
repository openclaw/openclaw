import type { MediaKind } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import type { PlaybackMediaProbeResult } from "./media-probe.js";

export type PlaybackMediaKind = Extract<MediaKind, "audio" | "video">;
export type PlaybackMode = "native" | "transcode";

export type PlaybackPolicyEntry = {
  nativeMimeTypes: readonly string[];
  codecProbeInputFormats: Readonly<Record<string, string>>;
  transcodeInputFormats: Readonly<Record<string, string>>;
  target: { contentType: string; extension: `.${string}` };
};

/**
 * Native means safe across the supported browser, AVPlayer, and ExoPlayer clients.
 * Client-specific formats stay in the transcode path because metadata cannot know its consumer.
 */
export const PLAYBACK_TRANSCODE_POLICY = {
  audio: {
    nativeMimeTypes: [
      "audio/m4a",
      "audio/mp3",
      "audio/mp4",
      "audio/mpeg",
      "audio/wav",
      "audio/wave",
      "audio/x-m4a",
      "audio/x-wav",
    ],
    codecProbeInputFormats: {
      "audio/m4a": "mov",
      "audio/mpeg": "mp3",
      "audio/mp4": "mov",
      "audio/wav": "wav",
      "audio/wave": "wav",
      "audio/x-m4a": "mov",
      "audio/x-wav": "wav",
    },
    transcodeInputFormats: {
      "audio/aac": "aac",
      "audio/aiff": "aiff",
      "audio/amr": "amr",
      "audio/amr-wb": "amr",
      "audio/flac": "flac",
      "audio/ogg": "ogg",
      "audio/opus": "ogg",
      "audio/vorbis": "ogg",
      "audio/webm": "matroska,webm",
      "audio/x-aiff": "aiff",
      "audio/x-caf": "caf",
      "audio/x-ms-asf": "asf",
      "audio/x-ms-wma": "asf",
    },
    target: { contentType: "audio/mp4", extension: ".m4a" },
  },
  video: {
    nativeMimeTypes: ["video/mp4"],
    codecProbeInputFormats: {
      "video/mp4": "mov",
    },
    transcodeInputFormats: {
      "video/avi": "avi",
      "video/flv": "flv",
      "video/matroska": "matroska,webm",
      "video/quicktime": "mov",
      "video/webm": "matroska,webm",
      "video/x-flv": "flv",
      "video/x-matroska": "matroska,webm",
      "video/x-ms-asf": "asf",
      "video/x-ms-wmv": "asf",
      "video/x-msvideo": "avi",
    },
    target: { contentType: "video/mp4", extension: ".mp4" },
  },
} as const satisfies Record<PlaybackMediaKind, PlaybackPolicyEntry>;

/** Returns whether a sniffed audio/video type needs the cross-client playback target. */
export function resolvePlaybackMode(
  mimeType: string,
  policy: PlaybackPolicyEntry,
): PlaybackMode | undefined {
  const mime = normalizeMimeType(mimeType);
  if (!mime) {
    return undefined;
  }
  if (policy.nativeMimeTypes.includes(mime)) {
    return "native";
  }
  return policy.transcodeInputFormats[mime] ? "transcode" : undefined;
}

export function resolvePlaybackInputFormat(
  policy: PlaybackPolicyEntry,
  mimeType: string,
): string | undefined {
  const normalized = normalizeMimeType(mimeType);
  return normalized
    ? (policy.transcodeInputFormats[normalized] ?? policy.codecProbeInputFormats[normalized])
    : undefined;
}

/** Combines selected audio/video codec facts without letting unknown facts hide incompatibility. */
export function resolveNativePlaybackCodecCompatibility(
  kind: PlaybackMediaKind,
  mimeType: string,
  probe: PlaybackMediaProbeResult,
): boolean | undefined {
  if (kind === "audio") {
    const codec = probe.audioCodec;
    if (probe.audioStreamIndex === undefined || !codec) {
      return undefined;
    }
    if (/^audio\/(?:x-wav|wav|wave)$/.test(normalizeMimeType(mimeType) ?? "")) {
      return codec === "pcm_s16le" || codec === "pcm_u8";
    }
    return codec === "mp3" || (normalizeMimeType(mimeType) !== "audio/mpeg" && codec === "aac");
  }

  const audioCompatible =
    probe.audioStreamIndex === undefined
      ? probe.audioCodec
        ? undefined
        : true
      : probe.audioCodec
        ? probe.audioCodec === "aac" || probe.audioCodec === "mp3"
        : undefined;
  let videoCompatible: boolean | undefined;
  if (probe.videoCodec && probe.videoStreamIndex !== undefined) {
    const portableProfile =
      probe.videoProfile === "baseline" ||
      probe.videoProfile === "constrained baseline" ||
      probe.videoProfile === "main" ||
      probe.videoProfile === "high";
    const portablePixelFormat =
      probe.videoPixelFormat === "yuv420p" || probe.videoPixelFormat === "yuvj420p";
    videoCompatible =
      probe.videoCodec === "h264" && probe.videoProfile && probe.videoPixelFormat
        ? portableProfile && portablePixelFormat
        : probe.videoCodec === "h264"
          ? undefined
          : false;
  }
  return audioCompatible === false || videoCompatible === false
    ? false
    : audioCompatible === true && videoCompatible === true
      ? true
      : undefined;
}
