import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentToolResult } from "../runtime/index.js";
import { sanitizeContentBlocksImages } from "../tool-images.js";

export type LoadedImageForTool = {
  buffer: Buffer;
  mimeType: string;
  resolvedImage: string;
  rewrittenFrom?: string;
  remoteSource?: boolean;
};

export function buildImageToolReferenceDetails(
  images: readonly LoadedImageForTool[],
): Record<string, unknown> {
  const single = images.length === 1 ? images[0] : undefined;
  if (single) {
    return {
      image: single.resolvedImage,
      ...(single.rewrittenFrom ? { rewrittenFrom: single.rewrittenFrom } : {}),
    };
  }
  return {
    images: images.map((image) => ({
      image: image.resolvedImage,
      ...(image.rewrittenFrom ? { rewrittenFrom: image.rewrittenFrom } : {}),
    })),
  };
}

export async function buildNativeImageToolResult(
  images: readonly LoadedImageForTool[],
  config?: OpenClawConfig,
): Promise<AgentToolResult<unknown>> {
  const content = await sanitizeContentBlocksImages(
    images.map((image) => ({
      type: "image" as const,
      data: image.buffer.toString("base64"),
      mimeType: image.mimeType,
    })),
    "image:native",
    { ...resolveImageSanitizationLimits(config), verifyDecodability: true },
  );
  // Sanitization replaces rejected image blocks with text at the same position.
  const retainedImages = images.filter((_, index) => content[index]?.type === "image");
  return {
    content: [
      {
        type: "text",
        text: `Loaded ${retainedImages.length} image${retainedImages.length === 1 ? "" : "s"} into private model context for inspection; not displayed, attached, or sent to the user.`,
      },
      ...content,
    ],
    details: {
      transport: "native",
      ...buildImageToolReferenceDetails(retainedImages),
      media: { outbound: false },
    },
  };
}
