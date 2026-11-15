import { detectMime } from "@openclaw/media-core/mime";
import type { AgentToolResult } from "../../packages/agent-core/src/types.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";

export async function imageResultFromFile(params: {
  label: string;
  path: string;
  extraText?: string;
  details?: Record<string, unknown>;
  imageSanitization?: ImageSanitizationLimits;
}): Promise<AgentToolResult<unknown>> {
  const buf = (await readLocalFileSafely({ filePath: params.path })).buffer;
  const mimeType = (await detectMime({ buffer: buf.slice(0, 256) })) ?? "image/png";
  const content: AgentToolResult<unknown>["content"] = [
    ...(params.extraText ? [{ type: "text" as const, text: params.extraText }] : []),
    {
      type: "image",
      data: buf.toString("base64"),
      mimeType,
    },
  ];
  const detailsMedia =
    params.details?.media &&
    typeof params.details.media === "object" &&
    !Array.isArray(params.details.media)
      ? params.details.media
      : undefined;
  const result: AgentToolResult<unknown> = {
    content,
    details: {
      path: params.path,
      ...params.details,
      media: {
        ...detailsMedia,
        mediaUrl: params.path,
      },
    },
  };
  const { sanitizeToolResultImages } = await import("./tool-images.runtime.js");
  return await sanitizeToolResultImages(result, params.label, params.imageSanitization);
}
