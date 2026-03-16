import type { VideoDescriptionRequest, VideoDescriptionResult } from "../../types.js";
import { generateGeminiInlineDataText } from "./inline-data.js";

export const DEFAULT_GOOGLE_VIDEO_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GOOGLE_VIDEO_MODEL = "gemini-3-flash-preview";
const DEFAULT_GOOGLE_VIDEO_PROMPT = "Describe the video.";

export async function describeGeminiVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const { text, model } = await generateGeminiInlineDataText({
    ...params,
    defaultBaseUrl: DEFAULT_GOOGLE_VIDEO_BASE_URL,
    defaultModel: DEFAULT_GOOGLE_VIDEO_MODEL,
    defaultPrompt: DEFAULT_GOOGLE_VIDEO_PROMPT,
    defaultMime: "video/mp4",
    httpErrorLabel: "Video description failed",
    missingTextError: "Video description response missing text",
  });
  return { text, model };
}
