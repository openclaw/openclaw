import { completeSimple, getModel } from "@mariozechner/pi-ai";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  ImageDescriptionRequest,
  ImageDescriptionResult,
  MediaUnderstandingProvider,
  VideoDescriptionRequest,
  VideoDescriptionResult,
} from "../../types.js";

const DEFAULT_VERTEX_MODEL = "gemini-3-flash-preview";

async function completeVertexMedia(params: {
  buffer: Buffer;
  mime: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  errorLabel: string;
}): Promise<{ text: string; model: string }> {
  const model = getModel("google-vertex", params.model as "gemini-3-flash-preview");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const result = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: params.prompt },
              {
                type: "image" as const,
                data: params.buffer.toString("base64"),
                mimeType: params.mime,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { signal: controller.signal },
    );

    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? (block as { text: string }).text.trim() : ""))
      .filter(Boolean)
      .join("\n");

    if (!text) {
      throw new Error(`${params.errorLabel} response missing text`);
    }

    return { text, model: result.model ?? params.model };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${params.errorLabel} timed out after ${params.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const googleVertexProvider: MediaUnderstandingProvider = {
  id: "google-vertex",
  capabilities: ["image", "audio", "video"],
  
  transcribeAudio: async (params: AudioTranscriptionRequest): Promise<AudioTranscriptionResult> => {
    return completeVertexMedia({
      buffer: params.buffer,
      mime: params.mime ?? "audio/wav",
      model: params.model ?? DEFAULT_VERTEX_MODEL,
      prompt: params.prompt?.trim() || "Transcribe the audio.",
      timeoutMs: params.timeoutMs,
      errorLabel: "Audio transcription",
    });
  },

  describeVideo: async (params: VideoDescriptionRequest): Promise<VideoDescriptionResult> => {
    return completeVertexMedia({
      buffer: params.buffer,
      mime: params.mime ?? "video/mp4",
      model: params.model ?? DEFAULT_VERTEX_MODEL,
      prompt: params.prompt?.trim() || "Describe the video.",
      timeoutMs: params.timeoutMs,
      errorLabel: "Video description",
    });
  },

  describeImage: async (params: ImageDescriptionRequest): Promise<ImageDescriptionResult> => {
    return completeVertexMedia({
      buffer: params.buffer,
      mime: params.mime ?? "image/jpeg",
      model: params.model ?? DEFAULT_VERTEX_MODEL,
      prompt: params.prompt?.trim() || "Describe the image.",
      timeoutMs: params.timeoutMs,
      errorLabel: "Image description",
    });
  },
};
