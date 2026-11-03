import { extensionForMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { generatedMusicAssetFromBase64 } from "./provider-assets.js";
import type { MusicGenerationRequest } from "./provider-types.js";
import type { GeneratedMusicAsset } from "./types.js";

/** Serialize music inputs without resolving credentials or choosing a transport. */
export function buildGoogleMusicGenerationBody(
  request: Pick<MusicGenerationRequest, "prompt" | "lyrics" | "instrumental" | "inputImages">,
) {
  const prompt = [request.prompt.trim()];
  const lyrics = normalizeOptionalString(request.lyrics);
  if (request.instrumental === true) {
    prompt.push("Instrumental only. No vocals, no sung lyrics, no spoken word.");
  }
  if (lyrics) {
    prompt.push(`Lyrics:\n${lyrics}`);
  }
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt.join("\n\n") },
          ...(request.inputImages ?? []).map((image) => ({
            inlineData: {
              mimeType: normalizeOptionalString(image.mimeType) || "image/png",
              data: image.buffer?.toString("base64") ?? "",
            },
          })),
        ],
      },
    ],
    generationConfig: { responseModalities: ["AUDIO", "TEXT"] },
  };
}

type GoogleMusicInlineData = { data?: string; mimeType?: string; mime_type?: string };
type GoogleMusicResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: GoogleMusicInlineData;
        inline_data?: GoogleMusicInlineData;
      }>;
    };
  }>;
};

/** Convert inline audio after the caller has applied its response/transport policy. */
export function parseGoogleMusicGenerationResponse(params: {
  response: GoogleMusicResponse;
  defaultFileExtension?: "mp3" | "wav";
  /** The native provider owns any base64 dialect normalization. */
  normalizeBase64?: (data: string) => string | undefined;
}): { tracks: GeneratedMusicAsset[]; lyrics?: string[] } {
  const lyrics: string[] = [];
  const tracks: GeneratedMusicAsset[] = [];
  for (const candidate of params.response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const text = normalizeOptionalString(part.text);
      if (text) {
        lyrics.push(text);
        continue;
      }
      const inline = part.inlineData ?? part.inline_data;
      const data = normalizeOptionalString(inline?.data);
      if (!data) {
        continue;
      }
      const mimeType =
        normalizeOptionalString(inline?.mimeType) ||
        normalizeOptionalString(inline?.mime_type) ||
        "audio/mpeg";
      const standardAudio = params.normalizeBase64 ? params.normalizeBase64(data) : data;
      if (!standardAudio) {
        throw new Error("Generated music asset contains malformed base64 audio data");
      }
      const ext =
        extensionForMime(mimeType)?.replace(/^\./u, "") || params.defaultFileExtension || "mp3";
      tracks.push(
        generatedMusicAssetFromBase64({
          base64: standardAudio,
          mimeType,
          fileName: `track-${tracks.length + 1}.${ext}`,
        }),
      );
    }
  }
  return { tracks, ...(lyrics.length > 0 ? { lyrics } : {}) };
}
